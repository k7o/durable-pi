// The run record: the conversation document `demo.job-runs` and the helpers that keep it consistent. One run is one
// pi-durable task whose task id is also the run id; this record says what happened in it, and it is what
// check_durable_job and the Tasks tab read.
//
// One run is stored in three places, and they answer different questions. Read them in this order:
//
//   the pi-durable task      where the run is: one task per run, its checkpoint { phase, iteration, data }. This is
//                            the only thing that resumes work, and the task id is the run id (engine.ts).
//   this document            what happened: one JobRun per task id holding phases, steps, approval and result. It is
//                            pruned to MAX_RUNS in engine.ts, newest kept.
//   App State (resultPath)   the answer a client reads. Written by a phase, never by the engine, so a run that fails
//                            before its last phase leaves the previous run's result in place.
//
// A phase is a checkpoint. A step is one recorded action inside it: command, tool, agent, state, approval, checkpoint
// or note.
import { defineDoc, type ConversationId, type RunningTask, type TaskId, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { JOB_RUNS_DOC, type JobPhaseRun, type JobRun, type JobRunsDoc, type JobStep } from "../../../../../dpi-sdk/src/jobs.js";
import type { Data, Values } from "./types.js";

export const JobRuns = defineDoc<JobRunsDoc>({
  kind: JOB_RUNS_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ counts: {}, items: {} }),
});

export type JobInput = { job: string; input: Values };
export type Checkpoint = { phase: string; iteration: number; data: Data; approvalTask?: number };
export type JobResult = { summary: string };
export type Run = TaskRuntime<JobInput, Checkpoint, JobResult, object>;
export type Running = RunningTask<JobInput, Checkpoint, JobResult>;

const MAX_STEPS = 40;
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function runOf(tx: Tx, task: { id: TaskId; conversationId: ConversationId }) {
  const run = (await tx.doc(JobRuns, task.conversationId)).items[String(task.id)];
  if (!run) throw Error(`Job run ${task.id} has no record`);
  return run;
}

export function upsertStep(phase: JobPhaseRun, step: JobStep) {
  const found = phase.steps.find((s) => s.id === step.id);
  if (found) Object.assign(found, step);
  else {
    phase.steps.push(step);
    if (phase.steps.length > MAX_STEPS) phase.steps = plain(phase.steps.slice(-MAX_STEPS));
  }
}

/** End a run early: the current phase gets `status`, later phases are skipped. */
export function endRun(run: JobRun, index: number, status: "failed" | "aborted", runStatus: JobRun["status"], message: string, now: number) {
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
