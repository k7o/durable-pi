// Durable jobs: repeatable workflows an agent (run_durable_job) or a person (Tasks tab) can start.
//
// Each job is one pi-durable task definition whose checkpoint phases are the job's named phases, so the task graph,
// the run record and the chat card all name the same phase. A phase does real work (shell commands in the session's
// folder, a subagent with read and bash, App State writes), records every step in the conversation document
// `demo.job-runs`, then commits the next checkpoint. A restart resumes the unfinished phase from its checkpoint.
//
// One run is stored in three places, and they answer different questions. Read them in this order:
//
//   the pi-durable task     where the run is: one task per run, its checkpoint { phase, iteration, data }.
//                           This is the only thing that resumes work, and the task id is the run id.
//   the job-runs document   what happened: one JobRun per task id, holding phases, steps, approval and result.
//                           Read by check_durable_job and the Tasks tab; pruned to MAX_RUNS, newest kept.
//   App State (resultPath)  the answer a client reads. Written by a phase, never by the engine, so a job that
//                           fails before its last phase leaves the previous run's result in place.
//
// A phase is a checkpoint. A step is one recorded action inside it: command, note, state, agent or checkpoint.
import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineDoc,
  defineTask,
  type ConversationId,
  type RunningTask,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools, createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { readState } from "../../dpi-sdk/src/app-state.js";
import type { WireAssistantMessage, WireMessage, WireToolResultMessage } from "../../dpi-sdk/src/api.js";
import { messageText } from "../../dpi-sdk/src/transcript.js";
import {
  JOB_RUNS_DOC,
  type JobDef,
  type JobPhaseRun,
  type JobRun,
  type JobRunsDoc,
  type JobStep,
} from "../../dpi-sdk/src/jobs.js";
import type { SharedState } from "./shared-state.js";
import { HANDLERS, JOB_DEFS } from "./features/jobs/defs.js";
import { clip } from "./features/jobs/shared.js";
import type { Data, Outcome, Phase, Values } from "./features/jobs/types.js";
import { Todos } from "./todos.js";

// The job catalogue moved to features/jobs/defs.ts in slice 3; these two are re-exported so every existing
// caller and test keeps its import path until the shim goes away in slice 4.
export { JOB_DEFS, jobDef, resolveJobInput } from "./features/jobs/defs.js";

export const JobRuns = defineDoc<JobRunsDoc>({
  kind: JOB_RUNS_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ counts: {}, items: {} }),
});

type JobInput = { job: string; input: Values };
type Checkpoint = { phase: string; iteration: number; data: Data; approvalTask?: number };
type JobResult = { summary: string };
type Run = TaskRuntime<JobInput, Checkpoint, JobResult, object>;
type Running = RunningTask<JobInput, Checkpoint, JobResult>;

/** Pause before each phase so a person can follow the run; durable, so a restart keeps the schedule. */
const PACE_MS = 900;
const MAX_RUNS = 30;
const MAX_STEPS = 40;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const tail = (s: string, lines = 8) => s.trim().split("\n").slice(-lines).join("\n");

// ------------------------------------------------------------------ the phase API job handlers use


// ------------------------------------------------------------------ run record helpers

async function runOf(tx: Tx, task: { id: TaskId; conversationId: ConversationId }) {
  const run = (await tx.doc(JobRuns, task.conversationId)).items[String(task.id)];
  if (!run) throw Error(`Job run ${task.id} has no record`);
  return run;
}

function upsertStep(phase: JobPhaseRun, step: JobStep) {
  const found = phase.steps.find((s) => s.id === step.id);
  if (found) Object.assign(found, step);
  else {
    phase.steps.push(step);
    if (phase.steps.length > MAX_STEPS) phase.steps = plain(phase.steps.slice(-MAX_STEPS));
  }
}

/** End a run early: the current phase gets `status`, later phases are skipped. */
function endRun(run: JobRun, index: number, status: "failed" | "aborted", runStatus: JobRun["status"], message: string, now: number) {
  run.status = runStatus;
  run.error = message;
  run.endedAt = now;
  run.phases.forEach((phase, i) => {
    if (i === index && phase.status !== "done") {
      phase.status = status;
      phase.endedAt = now;
      phase.summary = message;
      for (const step of phase.steps) if (step.status === "running" || step.status === "waiting") step.status = "error";
    } else if (i > index || (i === index && phase.status === "pending")) phase.status = "skipped";
  });
  if (run.approval === "pending") run.approval = "cancelled";
}

// ------------------------------------------------------------------ the engine

export interface JobsDeps {
  shared: SharedState;
  sessionId: string;
}

const CHILD_INSTRUCTIONS =
  "You are one phase of a durable job. Use only the commands and files the task names. Never edit or write files. Answer in at most 5 short lines.";

export function createJobs(deps: JobsDeps) {
  const Approval = defineTask<{ runId: number }, { phase: "wait" }, { approved: boolean }>({
    name: "demo.job-approval",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      // Reads the run's decision every 500 ms without writing; the button click is the only write.
      wait: async (task, runtime, ctx) => {
        for (;;) {
          const doc = await runtime.snapshot(JobRuns, task.conversationId, ctx);
          const decision = doc?.items[String(task.input.runId)]?.approval;
          if (decision && decision !== "pending") {
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: { approved: decision === "approved" } } }),
              ctx,
            );
            return;
          }
          await runtime.sleep(runtime.now() + 500, ctx);
        }
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

  const phaseApi = (def: JobDef, index: number, task: Running, runtime: Run, ctx: Context, run: JobRun): Phase => {
    const spec = def.phases[index];
    const cp = task.state.checkpoint;
    let counter = 0;
    const record = (fn: (run: JobRun, phase: JobPhaseRun) => void) =>
      runtime.commit(async (tx) => {
        const current = await runOf(tx, task);
        fn(current, current.phases[index]);
        current.updatedAt = runtime.now();
        return undefined;
      }, ctx);
    const shell = async (command: string) => {
      const env = await runtime.env(ctx);
      if (!env) throw Error("This session has no execution environment");
      let out = "";
      const result = await env.exec(command, { timeout: 60, onOutput: (text) => void (out.length < 50_000 && (out += text)) }, ctx);
      if (!result.ok) throw Error(`${command}: ${result.error.message}`);
      return { code: result.value.exitCode, out };
    };
    const step: Phase["step"] = async (kind, text, fn) => {
      const id = `${spec.id}:${cp.iteration}:${counter++}`;
      const at = runtime.now();
      await record((_r, phase) => upsertStep(phase, { id, kind, label: text, status: "running", iteration: cp.iteration, at }));
      try {
        const { value, detail } = await fn();
        await record((_r, phase) =>
          upsertStep(phase, { id, kind, label: text, status: "done", iteration: cp.iteration, at, ms: runtime.now() - at, ...(detail ? { detail: clip(detail, 600) } : {}) }),
        );
        return value;
      } catch (e) {
        if (!runtime.signal.aborted)
          await record((_r, phase) =>
            upsertStep(phase, { id, kind, label: text, status: "error", iteration: cp.iteration, at, ms: runtime.now() - at, detail: clip(String((e as Error)?.message ?? e), 600) }),
          );
        throw e;
      }
    };
    const stateKey = (path: string) => `job:${deps.sessionId}:${task.id}:${spec.id}:${cp.iteration}:${path}`;
    return {
      input: task.input.input,
      data: cp.data,
      iteration: cp.iteration,
      run: { id: task.id as number, n: run.run },
      now: () => runtime.now(),
      shell,
      step,
      exec: (command, text) =>
        step("command", text ?? command, async () => {
          const r = await shell(command);
          if (r.code !== 0) throw Error(`Exit ${r.code}: ${tail(r.out, 4)}`);
          return { value: r.out, detail: tail(r.out) || "(no output)" };
        }),
      note: (text, detail) => step("note", text, async () => ({ value: undefined, detail })),
      progress: (done, total) => record((_r, phase) => void (phase.progress = { done, total })),
      saveState: (path, value) =>
        step("state", `update_state ${path}`, async () => {
          const [, top] = path.split("/");
          const { value: root } = await deps.shared.snapshot();
          const parent = root[top];
          if (!parent || typeof parent !== "object" || Array.isArray(parent))
            await deps.shared.change({ operation: parent === undefined ? "create" : "update", path: `/${top}`, value: {} }, `${stateKey(path)}:parent`);
          const exists = (await deps.shared.snapshot()).value[top] as Record<string, unknown>;
          const key = path.split("/").slice(2).join("/");
          await deps.shared.change(
            { operation: Object.hasOwn(exists ?? {}, key) ? "update" : "create", path, value },
            stateKey(path),
          );
          return { value: undefined, detail: clip(JSON.stringify(value), 300) };
        }),
      readState: async (path) => {
        try {
          return readState((await deps.shared.snapshot()).value, path);
        } catch {
          return undefined;
        }
      },
      todos: async () => (await runtime.snapshot(Todos, task.conversationId, ctx)) ?? { items: [] },
      saveTodoDigest: (digest) =>
        runtime.commit(async (tx) => {
          (await tx.doc(Todos, task.conversationId)).digest = digest;
          return undefined;
        }, ctx),
      sleepUntil: (at) => runtime.sleep(at, ctx),
      agent: async (prompt) => {
        let childId = 0;
        const stepId = `${spec.id}:${cp.iteration}:agent`;
        const at = runtime.now();
        await runtime.commit(async (tx) => {
          const found = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
          if (found) childId = found.id as number;
          else {
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
            await configure(tx, child.id, {
              extensions: [CodingTools],
              tools: [createReadTool(), createBashTool()],
              instructions: CHILD_INSTRUCTIONS,
            });
            childId = child.id as number;
          }
          const current = await runOf(tx, task);
          current.childConversationId = childId;
          upsertStep(current.phases[index], {
            id: stepId,
            kind: "agent",
            label: `Subagent #${childId}`,
            detail: "Working with read and bash",
            status: "running",
            iteration: cp.iteration,
            at,
            conversationId: childId,
          });
          return undefined;
        }, ctx);
        const handle = await runtime.conversation(childId as ConversationId, ctx);
        if (!handle) throw Error(`Subagent #${childId} is missing`);
        const submission = await handle.submit(
          { type: "input", content: prompt, requestId: `job:${task.id}:${spec.id}` },
          ctx,
        );
        const settled = submission.wait(ctx);
        // Mirror the subagent's tool calls into the run record while it works; each call is its own pi.tool task.
        let seen = "";
        const sync = async () => {
          const view = await runtime.context(childId as ConversationId, ctx);
          const results = new Map<string, boolean>();
          const calls: { id: string; name: string; args: unknown }[] = [];
          for (const entry of view.entries) {
            for (const m of (entry.model ?? []) as unknown as WireMessage[]) {
              if (m.role === "toolResult") {
                const r = m as WireToolResultMessage;
                results.set(r.toolCallId, r.isError);
              }
              if (m.role === "assistant")
                for (const b of (m as WireAssistantMessage).content)
                  if (b.type === "toolCall") calls.push({ id: b.id, name: b.name, args: b.arguments });
            }
          }
          const key = JSON.stringify(calls.map((c) => [c.id, results.get(c.id)]));
          if (key === seen) return view;
          seen = key;
          await record((_r, phase) => {
            for (const c of calls) {
              const id = `${spec.id}:${cp.iteration}:tool:${c.id}`;
              const prior = phase.steps.find((s) => s.id === id);
              const status = !results.has(c.id) ? "running" : results.get(c.id) ? "error" : "done";
              const started = prior?.at ?? runtime.now();
              upsertStep(phase, {
                id,
                kind: "tool",
                label: c.name,
                detail: clip(summarizeArgs(c.args), 160),
                status,
                iteration: cp.iteration,
                at: started,
                conversationId: childId,
                // Only a call seen running has a measured duration; one that finished between polls has none.
                ...(status !== "running" && prior ? { ms: prior.ms ?? runtime.now() - started } : {}),
              });
            }
          });
          return view;
        };
        let done: Awaited<typeof settled> | undefined;
        while (!done) {
          runtime.signal.throwIfAborted();
          done = await Promise.race([
            settled,
            runtime.sleep(runtime.now() + 600, ctx).then(
              () => undefined,
              () => undefined,
            ),
          ]);
          await sync();
        }
        const view = await sync();
        const answer = done.status === "done" && done.type === "input" ? view.entries.find((e) => e.id === done.answer) : undefined;
        const text = answer ? ((answer.model ?? []) as unknown as WireMessage[]).map(messageText).join("").trim() : "";
        await record((_r, phase) =>
          upsertStep(phase, {
            id: stepId,
            kind: "agent",
            label: `Subagent #${childId}`,
            detail: clip(text || `Ended: ${done.status}`, 600),
            status: text ? "done" : "error",
            iteration: cp.iteration,
            at,
            ms: runtime.now() - at,
            conversationId: childId,
          }),
        );
        if (!text) throw Error(`Subagent #${childId} returned no answer (${done.status})`);
        return text;
      },
    };
  };

  /** Advance past phase `index`: the next phase's checkpoint, or the run's completed outcome. */
  const finish = (def: JobDef, index: number, task: Running, runtime: Run, ctx: Context, summary: string, data: Data) =>
    runtime.commit(async (tx) => {
      const run = await runOf(tx, task);
      const now = runtime.now();
      const phase = run.phases[index];
      phase.status = "done";
      phase.endedAt = now;
      phase.summary = summary;
      run.updatedAt = now;
      const next = def.phases[index + 1];
      if (next) {
        run.phase = next.id;
        run.status = "running";
        return { status: "running" as const, checkpoint: { phase: next.id, iteration: 0, data } };
      }
      run.status = "completed";
      run.result = summary;
      run.endedAt = now;
      return { status: "terminal" as const, outcome: { status: "completed" as const, result: { summary } } };
    }, ctx);

  const fail = (index: number, task: Running, runtime: Run, ctx: Context, message: string, runStatus: "failed" | "declined") =>
    runtime.commit(async (tx) => {
      const run = await runOf(tx, task);
      endRun(run, index, "failed", runStatus, message, runtime.now());
      run.updatedAt = runtime.now();
      return { status: "terminal" as const, outcome: { status: "failed" as const, error: { message } } };
    }, ctx);

  async function approvalPhase(def: JobDef, index: number, task: Running, runtime: Run, ctx: Context) {
    const spec = def.phases[index];
    const cp = task.state.checkpoint;
    if (cp.approvalTask === undefined) {
      await runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        const now = runtime.now();
        const phase = run.phases[index];
        phase.status = "waiting";
        phase.startedAt ??= now;
        run.status = "waiting";
        run.phase = spec.id;
        run.approval = "pending";
        run.updatedAt = now;
        upsertStep(phase, { id: `${spec.id}:0:decision`, kind: "approval", label: "Waiting for your decision", status: "waiting", iteration: 0, at: now });
        const approvalTask = await tx.createTask(Approval, { runId: task.id as number }, { ownership: { kind: "task", taskId: task.id } });
        return { status: "waiting", checkpoint: { ...cp, approvalTask: approvalTask as number }, on: [approvalTask], policy: "allSettled" };
      }, ctx);
      return;
    }
    const [outcome] = await runtime.outcomes([cp.approvalTask as TaskId<{ approved: boolean }>], ctx);
    const approved = outcome.status === "completed" && outcome.result.approved;
    const decided = (status: JobStep["status"], text: string) =>
      runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        const phase = run.phases[index];
        const step = phase.steps.find((s) => s.id === `${spec.id}:0:decision`);
        if (step) Object.assign(step, { status, label: text, ms: runtime.now() - step.at });
        return undefined;
      }, ctx);
    if (approved) {
      await decided("done", "Approved by you");
      await finish(def, index, task, runtime, ctx, "Approved by you", cp.data);
      return;
    }
    await decided("error", outcome.status === "completed" ? "Declined by you" : "Approval cancelled");
    if (outcome.status === "completed") await fail(index, task, runtime, ctx, "Declined by you", "declined");
    else
      await runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        endRun(run, index, "aborted", "aborted", "Approval cancelled", runtime.now());
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
  }

  async function runPhase(def: JobDef, index: number, task: Running, runtime: Run, ctx: Context) {
    const spec = def.phases[index];
    const cp = task.state.checkpoint;
    if (index > 0 && cp.iteration === 0 && cp.approvalTask === undefined) await runtime.sleep(runtime.now() + PACE_MS, ctx);
    if (spec.kind === "approval") return approvalPhase(def, index, task, runtime, ctx);

    // Enter the phase. Steps recorded by this same iteration mean a crash interrupted it: replace them.
    let resumed = false;
    let snapshot: JobRun | undefined;
    await runtime.commit(async (tx) => {
      const run = await runOf(tx, task);
      const phase = run.phases[index];
      const now = runtime.now();
      if (phase.status === "pending") phase.startedAt = now;
      else if (phase.steps.some((s) => s.iteration === cp.iteration)) {
        phase.steps = plain(phase.steps.filter((s) => s.iteration !== cp.iteration));
        run.resumed += 1;
        resumed = true;
      }
      phase.status = "running";
      run.status = "running";
      run.phase = spec.id;
      run.updatedAt = now;
      snapshot = plain(run);
      return undefined;
    }, ctx);
    const p = phaseApi(def, index, task, runtime, ctx, snapshot!);
    if (resumed) await p.note("Resumed from the last checkpoint after a restart");

    let outcome: Outcome;
    try {
      const handler = HANDLERS[def.id]?.[spec.id];
      if (!handler) throw Error(`No handler for ${def.id}/${spec.id}`);
      outcome = await handler(p);
    } catch (e) {
      if (runtime.signal.aborted) throw e;
      await fail(index, task, runtime, ctx, clip(String((e as Error)?.message ?? e), 400), "failed");
      return;
    }
    if ("again" in outcome) {
      const data = outcome.again;
      await runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        if (outcome.summary) run.phases[index].summary = outcome.summary;
        run.updatedAt = runtime.now();
        return { status: "running", checkpoint: { phase: spec.id, iteration: cp.iteration + 1, data } };
      }, ctx);
      return;
    }
    await finish(def, index, task, runtime, ctx, outcome.done, { ...cp.data, ...(outcome.data ?? {}) });
  }

  const tasks = JOB_DEFS.map((def) =>
    defineTask<JobInput, Checkpoint, JobResult>({
      name: `demo.job.${def.id}`,
      version: 1,
      initial: () => ({ phase: def.phases[0].id, iteration: 0, data: {} }),
      phases: Object.fromEntries(
        def.phases.map((spec, index) => [spec.id, (task: Running, runtime: Run, ctx: Context) => runPhase(def, index, task, runtime, ctx)]),
      ),
      abort: async (task, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          const run = await runOf(tx, task);
          const index = Math.max(0, def.phases.findIndex((p) => p.id === task.state.checkpoint.phase));
          endRun(run, index, "aborted", "aborted", "Stopped", runtime.now());
          run.updatedAt = runtime.now();
          return { status: "terminal", outcome: { status: "aborted" } };
        }, ctx);
      },
    }),
  );
  const taskOf = (id: string) => tasks[JOB_DEFS.findIndex((d) => d.id === id)];

  /**
   * Create a run inside a commit: the job's task and its record, together. `owner` makes the run part of that task's
   * work (a run_durable_job call); without it the conversation owns the run in the background.
   */
  async function start(
    tx: Tx,
    conversationId: ConversationId,
    opts: { def: JobDef; input: Values; startedBy: "agent" | "you"; toolCallId?: string; owner?: TaskId; now: number },
  ) {
    const background = opts.owner === undefined;
    const taskId = await tx.createTask(
      taskOf(opts.def.id),
      { job: opts.def.id, input: opts.input },
      { ownership: opts.owner === undefined ? { kind: "conversation" } : { kind: "task", taskId: opts.owner }, background },
    );
    const doc = await tx.doc(JobRuns, conversationId);
    const n = (doc.counts[opts.def.id] ?? 0) + 1;
    doc.counts[opts.def.id] = n;
    doc.items[String(taskId)] = {
      id: taskId as number,
      job: opts.def.id,
      title: opts.def.title,
      run: n,
      input: opts.input,
      startedBy: opts.startedBy,
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      background,
      status: "running",
      phase: opts.def.phases[0].id,
      phases: opts.def.phases.map((p) => ({ id: p.id, label: p.label, status: "pending" as const, steps: [] })),
      resumed: 0,
      startedAt: opts.now,
      updatedAt: opts.now,
    };
    const ids = Object.keys(doc.items).map(Number).sort((a, b) => a - b);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_RUNS))) delete doc.items[String(old)];
    return taskId;
  }

  return { defs: JOB_DEFS, tasks: [...tasks, Approval], start };
}

export type Jobs = ReturnType<typeof createJobs>;

function summarizeArgs(args: unknown) {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  return JSON.stringify(args);
}
