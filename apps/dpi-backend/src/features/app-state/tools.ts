// The App State tools. read_state reads the shared object at a JSON Pointer; update_state edits it and records the
// change in the transcript, committing the receipt in the same transaction so a replay returns the first result.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { readState } from "../../../../dpi-sdk/src/app-state.js";
import { TOOL_DESCRIPTIONS } from "../../prompt.js";
import type { SharedState } from "../../shared-state.js";
import { writing } from "../../tool-policy.js";
import type { Feature } from "../feature.js";
import { Receipt } from "../receipt.js";
import { Workspace } from "./doc.js";

export function appState(shared: SharedState, sessionId: string): Feature {
  const readAppState = defineTool({
    name: "read_state",
    description: TOOL_DESCRIPTIONS.read_state,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await shared.snapshot();
      return {
        content: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }],
      };
    },
  });
  const updateState = defineTool({
    name: "update_state",
    description: TOOL_DESCRIPTIONS.update_state,
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("increment"),
      ]),
      path: Type.String(),
      value_json: Type.Optional(
        Type.String({
          description:
            "JSON-encoded value. Objects and arrays must be encoded as JSON here, not passed as native tool argument objects.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const next = await shared.change(
        {
          operation: args.operation,
          path: args.path,
          value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
        },
        `agent:${sessionId}:${api.taskId}`,
      );
      const value = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (!receipt.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: "demo.state-change",
            data: { taskId: api.taskId, text: `App State: ${args.operation} ${args.path || "/"}` },
          });
          receipt.applied = true;
          receipt.result = JSON.stringify(next);
        }
        return receipt.result;
      }, ctx);
      return { content: [{ type: "text", text: value }] };
    },
  });

  return { docs: [Workspace], tools: [readAppState, writing(updateState)] };
}
