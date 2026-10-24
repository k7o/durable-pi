// What a job module is: one definition plus one handler per phase it declares. A handler reaches the run through
// the Phase object and never through the engine (Q6), so this file is the whole contract a job module needs, and
// runtime.ts is free to change how the phase is implemented.
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationDocToken } from "@earendil-works/pi-durable";
import type { JobDef, JobInputValue, JobStepKind } from "../../../../../dpi-sdk/src/jobs.js";
import type { TodoDigest, TodosDoc } from "../../../../../dpi-sdk/src/todos.js";
import type { SharedState } from "../../shared-state.js";

export type Values = Record<string, JobInputValue>;
export type Data = Record<string, JsonValue>;

/** Everything a phase handler may do: the run's inputs and checkpointed data, and the recorded effects. */
export interface Phase {
  readonly input: Values;
  readonly data: Data;
  readonly iteration: number;
  readonly run: { id: number; n: number };
  now(): number;
  /** Run a shell command in the session's folder and record it as a step. Throws on a non-zero exit. */
  exec(command: string, label?: string): Promise<string>;
  /** Run a shell command without recording it. */
  shell(command: string): Promise<{ code: number; out: string }>;
  step<T>(kind: JobStepKind, label: string, fn: () => Promise<{ value: T; detail?: string }>): Promise<T>;
  note(label: string, detail?: string): Promise<void>;
  progress(done: number, total: number): Promise<void>;
  saveState(path: string, value: JsonValue): Promise<void>;
  readState(path: string): Promise<JsonValue | undefined>;
  /** This conversation's todo document (demo.todos), created empty on first read. */
  todos(): Promise<Readonly<TodosDoc>>;
  /** Store the digest on the todo document in the same commit as this phase's checkpoint write. */
  saveTodoDigest(digest: TodoDigest): Promise<void>;
  /** Run a subagent with read and bash in an owned child conversation; its tool calls become steps. */
  agent(prompt: string): Promise<string>;
  sleepUntil(at: number): Promise<void>;
}

/** A phase either finishes (with the run data to carry forward) or checkpoints again for the same phase. */
export type Outcome = { done: string; data?: Data } | { again: Data; summary?: string };

export type Handler = (p: Phase) => Promise<Outcome>;

/**
 * What the engine and the phase object need from the device: the App State it writes, the session it names, and the
 * conversation document a job may read and annotate.
 */
export interface JobsDeps {
  readonly shared: SharedState;
  readonly sessionId: string;
  /** The todo document, supplied by the feature that owns it, so this feature imports no sibling. */
  readonly todos: ConversationDocToken<TodosDoc>;
}

/** One job, kept in one file: its metadata, its phases and the handler for each phase. */
export type JobModule = {
  readonly def: JobDef;
  readonly handlers: Readonly<Record<string, Handler>>;
};
