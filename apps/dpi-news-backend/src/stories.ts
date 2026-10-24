// The news desk's conversation document: one durable story list per conversation, plus the receipt the `news` tool
// reads before it edits anything.
//
// The shape lives in the SDK (`dpi-sdk/src/news.ts`) because clients read it too. The list is conversation-scoped, so
// every conversation and subagent has its own, and a fork takes the list as it was at the fork point.
import { defineDoc, type CheckpointInfo } from "@earendil-works/pi-durable";
import { STORIES_DOC, type StoriesDoc } from "../../dpi-sdk/src/news.js";

/**
 * Deltas the list keeps after its newest base before the next change is stored as a base. Every document must say
 * this (pi-durable 1.4.0); 32 bounds what a read replays and is the same policy the demo pack uses. It is written
 * here, not imported, because a new app must not depend on the demo app: if a third app wants it, move it into the
 * device's `pack.ts` and have both import it from there.
 */
const FOLD_AFTER = 32;

export const Stories = defineDoc<StoriesDoc>({
  kind: STORIES_DOC,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [], runs: 0 }),
  checkpointWhen: (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= FOLD_AFTER,
});

/** One receipt per tool call: a replay after a crash returns this result instead of editing the list twice. */
export const StoryReceipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "news.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: (_value: unknown, _ops: unknown, info: CheckpointInfo) => info.deltasSinceBase >= FOLD_AFTER,
});
