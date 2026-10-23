// The `todo` tool: this conversation's own durable list.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { TOOL_DESCRIPTIONS } from "../../prompt.js";
import { writing } from "../../tool-policy.js";
import type { Feature } from "../feature.js";
import { TodoReceipt, Todos } from "./doc.js";

/** The `todo` tool. It closes over nothing, so one definition serves every conversation and a test can drive it directly. */
export const TodoTool = defineTool({
  name: "todo",
  description: TOOL_DESCRIPTIONS.todo,
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("add"), Type.Literal("complete"), Type.Literal("reopen"), Type.Literal("remove")],
      { description: "What to do with the list." },
    ),
    text: Type.Optional(Type.String({ description: "Item text for add. Required for add." })),
    id: Type.Optional(Type.String({ description: "Item id from list. Required for complete, reopen and remove." })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const text = await api.commit(async (tx) => {
      // A replay after a crash reuses the first result: no duplicate add, no double toggle.
      const receipt = await tx.doc(TodoReceipt, api.taskId);
      if (receipt.applied) return receipt.result;
      const doc = await tx.doc(Todos, api.conversationId);
      let out: string;
      if (args.action === "list") {
        out = JSON.stringify({
          open: doc.items.filter((i) => !i.done).length,
          done: doc.items.filter((i) => i.done).length,
          items: doc.items,
        });
      } else if (args.action === "add") {
        const value = args.text?.trim();
        if (!value) throw Error("add needs text");
        if (value.length > 280) throw Error("text must be 280 characters or less");
        // The tool call's task id is unique and durable, so it is also the item id.
        const id = `t${api.taskId}`;
        if (!doc.items.some((i) => i.id === id)) doc.items.push({ id, text: value, done: false, createdAt: Date.now() });
        out = `Added ${id}: ${value}`;
      } else {
        const id = args.id?.trim();
        if (!id) throw Error(`${args.action} needs an item id from list`);
        const item = doc.items.find((i) => i.id === id);
        if (!item) throw Error(`No todo item ${id}. Use action list for ids.`);
        if (args.action === "complete") {
          item.done = true;
          item.doneAt ??= Date.now();
          out = `Completed ${id}: ${item.text}`;
        } else if (args.action === "reopen") {
          item.done = false;
          delete item.doneAt;
          out = `Reopened ${id}: ${item.text}`;
        } else {
          doc.items = doc.items.filter((i) => i.id !== id);
          out = `Removed ${id}: ${item.text}`;
        }
      }
      receipt.applied = true;
      receipt.result = out;
      return out;
    }, ctx);
    return { content: [{ type: "text", text }], details: { action: args.action } };
  },
});

export function todos(): Feature {
  return { docs: [Todos], tools: [writing(TodoTool)] };
}
