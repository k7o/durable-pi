// The phase runtime: how one phase of a run advances. A phase is a checkpoint, so a restart resumes it: on entry it
// replaces the steps this iteration already recorded, then dispatches to the job's handler and commits the next
// checkpoint (or the run's outcome). Approval phases are not handlers: they wait on their own task.
//
// A step is one recorded action inside a phase: command, note, state, agent or checkpoint. The Phase object a
// handler receives is built in phase.ts; the run record it writes is in record.ts; the tasks are in engine.ts.
import type { Context } from "@earendil-works/chord";
import type { TaskId } from "@earendil-works/pi-durable";
import type { JobDef } from "../../../../../dpi-sdk/src/api.js";
import type { JobRun, JobStep } from "../../../../../dpi-sdk/src/packs/demo-jobs.js";
import { Approval } from "./approval.js";
import { HANDLERS } from "./defs.js";
import { phaseApi } from "./phase.js";
import { endRun, plain, runOf, upsertStep, type Run, type Running } from "./record.js";
import { clip } from "./shared.js";
import type { Data, JobsDeps, Outcome } from "./types.js";

const PACE_MS = 900;

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

export async function runPhase(deps: JobsDeps, def: JobDef, index: number, task: Running, runtime: Run, ctx: Context) {
  const spec = def.phases[index];
  const cp = task.state.checkpoint;
  if (index > 0 && cp.iteration === 0 && cp.approvalTask === undefined) await new Promise<void>((resolve) => runtime.setTimer(resolve, PACE_MS));
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
  const p = phaseApi(deps, def, index, task, runtime, ctx, snapshot!);
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
  if ("sleep" in outcome) {
    // Park the run instead of holding the invocation: the engine resumes this phase at the same checkpoint, and a
    // restart in between resumes it the same way.
    await runtime.sleepUntil(outcome.sleep, cp, ctx);
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
