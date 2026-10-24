// Relevance, as a judgement from a classifier rather than a rule.
//
// The fetch run is deliberately dumb: read, dedupe, cap. This is the other half — it asks the device's classifier (Jev,
// when the provider serves one) how much each new story has to do with the topics this list states, and writes the answer
// into `relevance` while leaving the story where it is.
//
// Three decisions are the design:
//
//   1. **Score, do not delete.** A dropped story is unrecoverable and un-auditable; a low score is a threshold someone can
//      move later, and the list stays a true record of what the feeds offered. It also keeps `relevance` (a judgement)
//      apart from `score` (a person's ranking), so neither overwrites the other.
//   2. **One story per phase invocation**, committed before the next call, like the fetch run's one feed per invocation. A
//      judgement costs a request, so a restart must not pay for the same one twice.
//   3. **Fail open, loudly.** No classifier, no topics, or a call that fails is recorded in `doc.triage`, and the stories
//      stay unjudged — never dropped, never defaulted to zero. Same rule `jev-damage-control` documents for itself: when
//      the third party is unreachable, the thing proceeds.
import { defineTask } from "@earendil-works/pi-durable";
import type { Classify } from "../../dpi-backend/src/pack-api.js";
import type { StoryTriage } from "../../dpi-sdk/src/packs/news.js";
import { Stories } from "./stories.js";

/** The engine narrows a checkpoint by the phase its handler is running, so `phase` is a literal per variant. */
type TriageState = {
  index: number;
  /** What the run judged so far, carried in the checkpoint so a restart keeps the answers it already paid for. */
  judged: Record<string, number>;
  by?: { provider: string; model: string };
  /** Candidates this run will not reach, because a run is capped. */
  deferred: number;
  failed: number;
  error?: string;
};

type TriageCheckpoint = ({ phase: "triage" } | { phase: "write" }) & TriageState;

export type TriageResult = { scored: number; deferred: number; failed: number };

/** A run judges at most this many stories, so its cost is bounded. The rest is deferred to the next run, not dropped. */
const MAX_PER_RUN = 20;

const QUESTION = {
  relevance: {
    type: "score" as const,
    instructions: "How much does this item matter to someone whose interests are the topics given?",
    criteria: [
      "the item is about one of the topics, or would change how someone working on them thinks",
      "background, opinion and tooling for those topics count",
      "celebrity, sport, market prices, product deals and general world news do not",
    ],
  },
};

/** A classifier score is 0..1 on some services and 0..100 on others; a list wants 0..100 either way. */
const percent = (score: number) => Math.max(0, Math.min(100, Math.round(score <= 1 ? score * 100 : score)));

export function createNewsTriage(classify: Classify | undefined) {
  return defineTask<Record<string, never>, TriageCheckpoint, TriageResult>({
    name: "news.triage",
    version: 1,
    initial: () => ({ phase: "triage", index: 0, judged: {}, deferred: 0, failed: 0 }),
    phases: {
      triage: async (task, runtime, ctx) => {
        const cp = task.state.checkpoint;
        const finish = async (error: string | undefined, deferred: number) => {
          await runtime.commit(
            () => ({
              status: "running" as const,
              checkpoint: { ...cp, phase: "write" as const, deferred, ...(error ? { error } : {}) },
            }),
            ctx,
          );
        };

        // A failure earlier in this run, or nothing left to judge: hand over to the phase that writes what was judged.
        if (cp.error) return finish(cp.error, cp.deferred);

        const doc = (await runtime.snapshot(Stories, task.conversationId, ctx)) ?? { items: [], runs: 0 };
        const topics = doc.topics ?? [];
        // A story someone already ranked is theirs, and one already judged costs nothing to leave alone.
        const candidates = doc.items.filter((story) => story.relevance === undefined && story.score === undefined);
        // The three ways a run can have nothing to judge. Recorded, not thrown: a list that cannot be judged right now is
        // still a list, and the record is how a client tells "not judged yet" from "judged irrelevant".
        const stop = !topics.length
          ? "no topics on this list: set them with the news tool, action topics"
          : !classify
            ? "no classifier on this device: relevance needs one (Jev is served by typesafe or opencode)"
            : candidates.length === 0
              ? "nothing left to judge"
              : undefined;
        if (stop) return finish(stop, 0);

        const batch = candidates.slice(0, MAX_PER_RUN);
        const deferred = candidates.length - batch.length;
        const story = batch[cp.index];
        if (!story) return finish(cp.error, deferred);

        let { judged, by, failed } = cp;
        let error = cp.error;
        try {
          const result = await classify!(
            {
              state: {
                title: story.title,
                ...(story.url ? { url: story.url } : {}),
                ...(story.source ? { source: story.source } : {}),
                topics,
              },
              questions: QUESTION,
            },
            { signal: runtime.signal },
          );
          const answer = result.answers.relevance;
          if (answer?.type === "score") {
            judged = { ...judged, [story.id]: percent(answer.score) };
            by = { provider: String(result.provider), model: result.model };
          } else {
            // A stopped request is not a verdict, so it stops the run rather than scoring the story zero.
            error = result.errorMessage ?? `classifier did not answer (${result.stopReason})`;
            failed += 1;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          failed += 1;
        }
        await runtime.commit(
          () => ({
            status: "running" as const,
            checkpoint: {
              ...cp,
              index: cp.index + 1,
              judged,
              failed,
              deferred,
              ...(by ? { by } : {}),
              ...(error ? { error } : {}),
            },
          }),
          ctx,
        );
      },

      write: async (task, runtime, ctx) => {
        if (task.state.checkpoint.phase !== "write") return;
        const { judged, by, deferred, failed, error } = task.state.checkpoint;
        const at = runtime.now();
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(Stories, task.conversationId);
          for (const [id, relevance] of Object.entries(judged)) {
            const story = doc.items.find((item) => item.id === id);
            if (!story) continue; // Removed while the run was in flight; nothing to judge.
            story.relevance = relevance;
            if (by) story.relevanceBy = { ...by, at };
          }
          const triage: StoryTriage = {
            at,
            // Copied, so the scores stay interpretable after someone changes the topics.
            topics: doc.topics ?? [],
            scored: Object.keys(judged).length,
            deferred,
            failed,
            ...(error ? { error } : {}),
          };
          // The scores and the record of the run that produced them land in one commit, so no reader sees a score with no
          // run behind it.
          doc.triage = triage;
          return {
            status: "terminal" as const,
            outcome: {
              status: "completed" as const,
              result: { scored: triage.scored, deferred, failed },
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
