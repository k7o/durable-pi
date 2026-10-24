// One digest run: a single durable phase that reads this conversation's stories, ranks the numbers and commits its
// summary onto the list. It is the minimum shape of a task on pi-durable — one phase, one commit, one outcome — and
// it is what `news` `digest` starts.
import { defineTask } from "@earendil-works/pi-durable";
import type { StoryDigest } from "../../dpi-sdk/src/news.js";
import { Stories } from "./stories.js";

export type DigestResult = { run: number; open: number; ranked: number; top?: string };

export const NewsDigest = defineTask<Record<string, never>, { phase: "digest" }, DigestResult>({
  name: "news.digest",
  version: 1,
  initial: () => ({ phase: "digest" }),
  phases: {
    digest: async (task, runtime, ctx) => {
      const stories = (await runtime.snapshot(Stories, task.conversationId, ctx)) ?? { items: [], runs: 0 };
      const ranked = stories.items
        .filter((story) => story.score !== undefined)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const open = stories.items.length - ranked.length;
      const at = runtime.now();
      // The summary and the digest counter land in the same commit as the outcome, so no reader sees a run counted
      // without its digest, or the other way round.
      const summary: StoryDigest & { run: number } = {
        run: stories.runs + 1,
        at,
        open,
        ranked: ranked.length,
        ...(ranked[0] ? { top: ranked[0].title } : {}),
      };
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(Stories, task.conversationId);
        doc.runs += 1;
        doc.digest = summary;
        return {
          status: "terminal" as const,
          outcome: {
            status: "completed" as const,
            result: { run: summary.run, open, ranked: ranked.length, ...(summary.top ? { top: summary.top } : {}) },
          },
        };
      }, ctx);
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});
