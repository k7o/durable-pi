// The engine: one pi-durable task per job, built from the catalogue, and the transaction that starts a run so the
// task and its record cannot disagree. The phase runtime it dispatches into is runtime.ts.
import type { Context } from "@earendil-works/chord";
import { defineTask, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { JobDef } from "../../../../../dpi-sdk/src/api.js";
import { Approval } from "./approval.js";
import { JOB_DEFS } from "./defs.js";
import { JobRuns, endRun, runOf, type Checkpoint, type JobInput, type JobResult, type Run, type Running } from "./record.js";
import { runPhase } from "./runtime.js";
import type { JobsDeps, Values } from "./types.js";

const MAX_RUNS = 30;

export function createJobs(deps: JobsDeps) {
  const tasks = JOB_DEFS.map((def) =>
    defineTask<JobInput, Checkpoint, JobResult>({
      name: `demo.job.${def.id}`,
      version: 1,
      initial: () => ({ phase: def.phases[0].id, iteration: 0, data: {} }),
      phases: Object.fromEntries(
        def.phases.map((spec, index) => [spec.id, (task: Running, runtime: Run, ctx: Context) => runPhase(deps, def, index, task, runtime, ctx)]),
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
