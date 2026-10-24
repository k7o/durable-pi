// The two tools every device offers for its own shared document. App State is the device's store, so an agent on any
// device reads and changes it with the same pair: a pack supplies what is specific to a product, never this.
//
// `read_state` reads at a JSON Pointer. `update_state` applies one atomic path operation, and its receipt makes a
// replayed call return its first result instead of incrementing twice; the transcript entry that records the change is
// committed under its own receipt, so a replay does not append it again either.
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { readState, type StateChange } from "../../dpi-sdk/src/app-state.js";
import type { SharedState } from "./app-state.js";
import { foldEvery } from "./pack.js";
import { writing } from "./tool-policy.js";

/** Descriptions are prompt: changing the wording is a behaviour change for every agent on the device. */
export const STATE_TOOL_DESCRIPTIONS = {
  read_state:
    "Read the shared App State object used by every session, conversation and fork on this device, or a field at a JSON Pointer path. An empty path reads the whole object.",
  update_state:
    'CRUD the shared App State for every agent and fork on this device. create adds a new field, update replaces an existing value, delete removes it, increment adds a signed number. value_json must be JSON-encoded text: 3 for a number, true for a boolean, "hello" (including quotes) for a string, {"enabled":true} for an object, or [1,2] for an array. Omit value_json for delete. Use JSON Pointer paths: /counter, /settings/enabled, /notes/- to append. Escape ~ as ~0 and / as ~1. An empty path with update replaces the whole root object, with delete clears it. Read first with read_state. Changes are atomic and replay-safe.',
} as const;

/** The transcript entry a state change appends. The kind is the device's: App State is not a pack's document. */
export const STATE_ENTRY_KIND = "app-state.change";

/** One entry per state change, so a replay after a crash does not append the transcript entry twice. */
const Entry = defineDoc<{ applied: boolean }>({
  kind: "app-state.entry",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false }),
  checkpointWhen: foldEvery(),
});

export function stateTools(appState: SharedState, sessionId: string) {
  const readStateTool = defineTool({
    name: "read_state",
    description: STATE_TOOL_DESCRIPTIONS.read_state,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await appState.snapshot();
      return { output: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }] };
    },
  });

  const updateStateTool = defineTool({
    name: "update_state",
    description: STATE_TOOL_DESCRIPTIONS.update_state,
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
      const change: StateChange = {
        operation: args.operation,
        path: args.path,
        value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
      };
      // The receipt lives in the App State store, keyed by this call, so a replay returns the first result without
      // applying the change again.
      const next = await appState.change(change, `agent:${sessionId}:${api.taskId}`);
      const text = await api.commit(async (tx) => {
        const entry = await tx.doc(Entry, api.taskId);
        if (!entry.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: STATE_ENTRY_KIND,
            data: { taskId: api.taskId, text: `App State: ${change.operation} ${change.path || "/"}` },
          });
          entry.applied = true;
        }
        return JSON.stringify(next);
      }, ctx);
      return { output: [{ type: "text", text }] };
    },
  });

  return defineExtension({
    name: "state",
    tools: [readStateTool, writing(updateStateTool)],
  });
}
