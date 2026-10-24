// The news desk's conversation document: one durable story list per conversation, plus the receipt the `news` tool
// reads before it edits anything.
//
// The shape lives in the SDK (`dpi-sdk/src/packs/news.ts`) because clients read it too. The list is conversation-scoped, so
// every conversation and subagent has its own, and a fork takes the list as it was at the fork point.
import { defineDoc } from "@earendil-works/pi-durable";
import { foldEvery } from "../../dpi-backend/src/pack-api.js";
import { STORIES_DOC, type StoriesDoc } from "../../dpi-sdk/src/packs/news.js";

export const Stories = defineDoc<StoriesDoc>({
  kind: STORIES_DOC,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [], runs: 0 }),
  checkpointWhen: foldEvery(),
});

/** One receipt per tool call: a replay after a crash returns this result instead of editing the list twice. */
export const StoryReceipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "news.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: foldEvery(),
});
