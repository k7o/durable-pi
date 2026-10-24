// The demo pack's job runs, as clients read them: the conversation document `demo.job-runs`, so a shell renders the
// same phases, steps and approval that the pack wrote, live and after a restart. Types are aliases (not interfaces) so
// they stay JSON documents.
//
// This file belongs to the demo pack: `demo-jobs`, `demo-todos` and `news` in this directory are each one product's wire
// types, kept next to the device contract so a client can read them without importing the pack. What a device
// *advertises* about jobs is not here — `JobDef` and its inputs are in `api.ts`, because `/v1/device` carries them.

import type { JobInputValue } from "../api.js";

export const JOB_RUNS_DOC = "demo.job-runs";

export type JobStepKind = "command" | "tool" | "agent" | "state" | "approval" | "checkpoint" | "note";
export type JobStepStatus = "running" | "done" | "error" | "waiting";
export type JobPhaseStatus = "pending" | "running" | "waiting" | "done" | "failed" | "aborted" | "skipped";
export type JobRunStatus = "running" | "waiting" | "completed" | "failed" | "aborted" | "declined";

export type JobStep = {
  id: string;
  kind: JobStepKind;
  label: string;
  detail?: string;
  status: JobStepStatus;
  /** The phase iteration that recorded the step; a resumed iteration replaces its own steps. */
  iteration: number;
  at: number;
  ms?: number;
  /** For subagent steps: the child conversation that made the call. */
  conversationId?: number;
};

export type JobPhaseRun = {
  id: string;
  label: string;
  status: JobPhaseStatus;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  steps: JobStep[];
  progress?: { done: number; total: number };
};

export type JobRun = {
  /** The job's durable task id. */
  id: number;
  job: string;
  title: string;
  /** The nth run of this job in this conversation. */
  run: number;
  input: Record<string, JobInputValue>;
  startedBy: "agent" | "you";
  /** Set when the agent started the run: the run_durable_job call that owns it. */
  toolCallId?: string;
  background: boolean;
  status: JobRunStatus;
  phase?: string;
  phases: JobPhaseRun[];
  approval?: "pending" | "approved" | "declined" | "cancelled";
  childConversationId?: number;
  /** How many times the run continued from a checkpoint after a restart. */
  resumed: number;
  result?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
};

export type JobRunsDoc = { counts: Record<string, number>; items: Record<string, JobRun> };

export const jobRunDone = (run: Pick<JobRun, "status">) =>
  run.status !== "running" && run.status !== "waiting";
