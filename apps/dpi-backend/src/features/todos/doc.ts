// The experiment's conversation document: one durable todo list per conversation.
//
// The agent edits it through the `todo` tool (tools.ts), a one-phase job summarises it
// (../jobs/todo-digest.ts), and the web UI can read it from GET /sessions/:s/docs/demo.todos. It lives in the
// conversation, so a fork decides what to copy (`fork: "asOf"`) and every edit is part of the same commit as the
// tool call's receipt.
import { defineDoc } from "@earendil-works/pi-durable";

export const TODOS_DOC = "demo.todos";

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  doneAt?: number;
};

/** The last todo-digest run's summary, written by the job and read by the UI. */
export type TodoDigest = {
  run: number;
  at: number;
  open: number;
  done: number;
  text: string;
};

export type TodosDoc = {
  items: TodoItem[];
  digest?: TodoDigest;
};

export const Todos = defineDoc<TodosDoc>({
  kind: TODOS_DOC,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
});

/** One receipt per tool call: a replay after a crash returns this result instead of editing the list twice. */
export const TodoReceipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.todo-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
});
