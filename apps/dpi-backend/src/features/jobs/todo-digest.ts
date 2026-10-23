// One phase: read this conversation's todo list, then save the digest to App State and the list.
import type { JobDef } from "../../../../dpi-sdk/src/jobs.js";
import { RESULT_ROOT } from "./shared.js";
import type { Handler, JobModule } from "./types.js";

const def: JobDef = {
  id: "todo-digest",
  title: "Todo digest",
  summary: "Read this conversation's todo list in one checkpointed phase, save a one-line digest on the list and in App State.",
  phases: [{ id: "digest", label: "Digest", summary: "Count open and done items and name the oldest open one" }],
  inputs: [],
  approval: false,
  resultPath: `/${RESULT_ROOT}/todo-digest`,
  seconds: 2,
};

const handlers: Record<string, Handler> = {
    digest: async (p) => {
      const doc = await p.todos();
      const open = doc.items.filter((i) => !i.done);
      const done = doc.items.filter((i) => i.done);
      await p.step("note", "Read the todo list", async () => ({
        value: undefined,
        detail: `${doc.items.length} items: ${open.length} open, ${done.length} done`,
      }));
      if (!doc.items.length) return { done: "Todo list is empty; nothing to digest", data: { open: 0, done: 0, text: "Todo list is empty" } };
      const oldest = [...open].sort((a, b) => a.createdAt - b.createdAt)[0];
      const text = `${open.length} open, ${done.length} done${oldest ? `; oldest open: ${oldest.text}` : ""}`;
      await p.step("state", "Save the digest", async () => {
        const at = p.now();
        await p.saveState(`/${RESULT_ROOT}/todo-digest`, {
          run: p.run.n,
          at: new Date(at).toISOString(),
          open: open.length,
          done: done.length,
          text,
        });
        // The same phase also writes the conversation document, so the UI shows the digest next to the list.
        await p.saveTodoDigest({ run: p.run.n, at, open: open.length, done: done.length, text });
        return { value: undefined, detail: text };
      });
      return { done: text, data: { open: open.length, done: done.length, text } };
    },
};

export const todoDigest: JobModule = { def, handlers };
