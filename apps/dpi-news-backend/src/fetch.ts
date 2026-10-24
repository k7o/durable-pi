// A durable fetch run: read every feed, skip what the list already has, and record what each feed did.
//
// The shape is the point. One phase invocation fetches ONE feed and commits its progress before returning, so a device
// that restarts in the middle of a run resumes at the next feed instead of at the first one — and the commit is also what
// tells the engine to run the phase again (`status: "running"` with a checkpoint that names the next index). Doing all
// feeds in a single invocation would be shorter and would lose that: a crash after the fourth feed would re-fetch the
// first three.
//
// Nothing here throws on a bad feed. A site that is down, slow, or answers with an HTML error page is recorded as a
// failed source in the run's summary and the other feeds still land, because "the Verge is down" is not a reason for the
// Hacker News stories not to be in the list. A *whole* run fails only when it cannot write, which is the one thing that
// means something is wrong with the device rather than with a website.
import { defineTask } from "@earendil-works/pi-durable";
import type { StoryFetch, StoryFetchSource, StorySource } from "../../dpi-sdk/src/packs/news.js";
import { DEFAULT_SOURCES, parseFeed, type FeedItem } from "./sources.js";
import { Stories } from "./stories.js";

/** Input is empty for a tool-started run (it uses the pack's sources); a test or a person can override them. */
export type FetchInput = { sources?: readonly StorySource[] };

type FetchCheckpoint =
  | { phase: "fetch"; index: number; items: (FeedItem & { source: string })[]; sources: StoryFetchSource[] }
  | { phase: "commit"; items: (FeedItem & { source: string })[]; sources: StoryFetchSource[] };

export type FetchResult = { added: number; skipped: number; sources: number };

/** A run is capped so one surprising feed cannot fill the list; the per-source `limit` applies first. */
const MAX_ITEMS = 40;
const TIMEOUT_MS = 10_000;

const firstLine = (value: string) => value.split("\n")[0]?.trim().slice(0, 200) ?? "";

async function fetchFeed(source: StorySource, signal: AbortSignal) {
  const res = await fetch(source.url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    headers: {
      // A named client and a feed content type: feeds serve HTML to some user agents, and a 403 usually means "no bot".
      "user-agent": "durable-pi-news/1 (+https://github.com/k7o/durable-pi)",
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
    },
  });
  if (!res.ok) {
    // The body of a blocked request says why (a network policy, a proxy), so keep its first line in the failure.
    const body = firstLine(await res.text().catch(() => ""));
    throw Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  const xml = await res.text();
  const items = parseFeed(xml, source);
  if (!items.length) throw Error("no readable items (is that a feed URL?)");
  return items;
}

/**
 * The fetch task. `sources` is the pack's list unless the run was started with its own, which is what lets a test point
 * it at a local server and lets a device read a different set without a code change.
 */
export function createNewsFetch(sources: readonly StorySource[] = DEFAULT_SOURCES) {
  return defineTask<FetchInput, FetchCheckpoint, FetchResult>({
    name: "news.fetch",
    version: 1,
    initial: () => ({ phase: "fetch", index: 0, items: [], sources: [] }),
    phases: {
      fetch: async (task, runtime, ctx) => {
        const list = task.input.sources?.length ? task.input.sources : sources;
        const cp = task.state.checkpoint;
        const source = cp.phase === "fetch" ? list[cp.index] : undefined;
        if (!source) {
          // Every feed has been read: one more commit hands the run to the phase that writes the list.
          await runtime.commit(
            () => ({ status: "running" as const, checkpoint: { phase: "commit" as const, items: cp.items, sources: cp.sources } }),
            ctx,
          );
          return;
        }
        let summary: StoryFetchSource;
        let fetched: (FeedItem & { source: string })[] = [];
        try {
          fetched = (await fetchFeed(source, runtime.signal)).map((item) => ({ ...item, source: source.id }));
          summary = { id: source.id, ok: true, added: 0, skipped: 0 };
        } catch (err) {
          summary = {
            id: source.id,
            ok: false,
            added: 0,
            skipped: 0,
            error: firstLine(err instanceof Error ? err.message : String(err)) || "fetch failed",
          };
        }
        // Progress is committed before the next fetch starts, so a restart resumes at the next feed. The story counts are
        // filled in by the commit phase, which is the only place that knows what the list already had.
        await runtime.commit(
          () => ({
            status: "running" as const,
            checkpoint: {
              phase: "fetch" as const,
              index: cp.index + 1,
              items: [...cp.items, ...fetched].slice(0, MAX_ITEMS),
              sources: [...cp.sources, summary],
            },
          }),
          ctx,
        );
      },

      commit: async (task, runtime, ctx) => {
        if (task.state.checkpoint.phase !== "commit") return;
        const { items, sources: reports } = task.state.checkpoint;
        const at = runtime.now();
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(Stories, task.conversationId);
          // Dedupe on the link, and on the title when a feed carried no link: a second run over the same feeds has to add
          // nothing, which is what makes running it on a timer safe later.
          const known = new Set(doc.items.map((story) => story.url ?? `title:${story.title}`));
          const storyOf = (item: FeedItem & { source: string }) => item.url ?? `title:${item.title}`;
          const fresh = items.filter((item) => !known.has(storyOf(item)));
          for (const item of fresh) {
            doc.items.push({
              // The run's task id plus a position in this run: unique, and stable if the commit is retried.
              id: `f${task.id}-${doc.items.length}`,
              title: item.title,
              ...(item.url ? { url: item.url } : {}),
              source: item.source,
              ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
              addedAt: at,
            } satisfies (typeof doc.items)[number]);
          }
          const skipped = items.length - fresh.length;
          const fetch: StoryFetch = {
            at,
            added: fresh.length,
            skipped,
            sources: reports.map((report) => {
              const mine = items.filter((item) => item.source === report.id);
              const added = fresh.filter((item) => item.source === report.id).length;
              return { ...report, added, skipped: mine.length - added };
            }),
          };
          // The list and the summary of the run that filled it land in one commit, so no reader sees stories the summary
          // does not account for.
          doc.fetch = fetch;
          return {
            status: "terminal" as const,
            outcome: {
              status: "completed" as const,
              result: { added: fetch.added, skipped, sources: reports.length },
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
