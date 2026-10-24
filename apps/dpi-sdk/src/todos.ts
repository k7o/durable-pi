// The todo list as clients read it: one durable list per conversation, served at `demo.todos`, plus the last digest a
// job wrote onto it. Types are aliases (not interfaces) so they stay JSON documents. The document itself is defined
// next to the tool that edits it (`apps/dpi-backend/src/playground/features/todos/doc.ts`).

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
