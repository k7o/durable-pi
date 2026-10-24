// One digest run: a single durable phase that reads this conversation's stories, ranks the numbers, commits its
// summary onto the list and records it in App State. It is the minimum shape of a task on pi-durable — one phase, one
// commit, one outcome — and it is what the `news` tool's `digest` action starts.
//
// The task is built per session because the device hands each pack its App State store: a second app reads and writes
// the same shared document as the demo without importing the demo.
import { defineTask } from "@earendil-works/pi-durable";
import type { SharedState } from "../../dpi-backend/src/pack-api.js";
import type { StoryDigest } from "../../dpi-sdk/src/news.js";
import { Stories } from "./stories.js";

export type DigestResult = { run: number; open: number; ranked: number; top?: string };

/** Where a run's summary lands in App State: one key under the app's name, so packs share one document. */
export const RESULT_PATH = "/news";

export function createNewsDigest(appState: SharedState) {
  return defineTask<Record<string, never>, { phase: "digest" }, DigestResult>({
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
        const summary: StoryDigest = {
          run: stories.runs + 1,
          at,
          open,
          ranked: ranked.length,
          ...(ranked[0] ? { top: ranked[0].title } : {}),
        };
        // The last run's summary is a fact about the device, so it goes in App State as well as on this conversation's
        // list. Written before the run's own outcome: a crash between the two reruns the phase and writes the same value.
        const shared = await appState.snapshot();
        await appState.change({
          operation: Object.hasOwn(shared.value, "news") ? "update" : "create",
          path: RESULT_PATH,
          value: { ...summary },
        });
        // The summary and the digest counter land in the same commit as the outcome, so no reader sees a run counted
        // without its digest, or the other way round.
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
}
