// The history tool: search this conversation's own stored entries, including what a reset, handoff or compaction
// hid. It reads the transcript through the tool API and never writes.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type EntryRecord } from "@earendil-works/pi-durable";
import type { WireEntry } from "../../../../../dpi-sdk/src/api.js";
import { TOOL_DESCRIPTIONS } from "../../prompt.js";
import type { Feature } from "../feature.js";
import { searchHistory } from "../../history.js";

  const searchHistoryTool = defineTool({
    name: "search_history",
    description: TOOL_DESCRIPTIONS.search_history,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words that must all appear, case-insensitive." })),
      tool: Type.Optional(Type.String({ description: "Only calls to and results from this tool, for example bash." })),
      entry: Type.Optional(Type.Integer({ minimum: 1, description: "Read this one entry in full." })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("tool_call"),
          Type.Literal("tool_result"),
          Type.Literal("event"),
        ]),
      ),
      from_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Oldest entry number to include." })),
      to_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Newest entry number to include." })),
      order: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results per page. Default 10." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Results to skip. Default 0." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { entries, activeFrom } = await api.commit(async (tx) => {
        const all: EntryRecord[] = [];
        let page = await tx.scanEntries({ conversationId: api.conversationId }, 500);
        all.push(...page.items);
        while (page.next && all.length < 10_000) {
          page = await tx.scanEntries({ conversationId: api.conversationId }, 500, page.next);
          all.push(...page.items);
        }
        return { entries: all, activeFrom: (await tx.latestHeadMarker(api.conversationId))?.head as number | undefined };
      }, ctx);
      const resets = entries.filter((e) => e.kind === "pi.reset").map((e) => e.id as number);
      const result = searchHistory(entries as unknown as WireEntry[], args, {
        activeFrom,
        lastReset: resets.length ? Math.max(...resets) : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

export function historyTools(): Feature {
  return { tools: [searchHistoryTool] };
}
