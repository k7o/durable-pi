// The news pack's story list, as clients read it: one durable story list per conversation, served at `news.stories`,
// plus the last digest and the last fetch a run wrote onto it. Belongs to the news pack; see `demo-jobs.ts` for the rule.
// Types are aliases (not interfaces) so they stay JSON documents. The document itself is defined next to the tool that
// edits it (`apps/dpi-news-backend/src/stories.ts`).

export const STORIES_DOC = "news.stories";

export type Story = {
  /** `s<taskId>` of the tool call that added it, so a replay cannot add the same story twice. */
  id: string;
  title: string;
  url?: string;
  /** 0 to 100 once someone ranked it; absent means it is still waiting for a look. */
  score?: number;
  /**
   * 0 to 100 from a triage run: how relevant a classifier judged it to be to this list's `topics`. Kept apart from
   * `score`, which is a person's ranking, so a judgement and an opinion never overwrite each other.
   */
  relevance?: number;
  /** Which classifier answered, and when. Absent when the score came from anywhere else. */
  relevanceBy?: { provider: string; model: string; at: number };
  /** Which feed a fetch run took it from; absent when a person or the agent added it by hand. */
  source?: string;
  /** The feed's own date, when it carried one. */
  publishedAt?: number;
  addedAt: number;
};

/** One feed a fetch run reads. `url` has to return RSS or Atom — the parser reads those two, not HTML. */
export type StorySource = {
  id: string;
  name: string;
  url: string;
  /** How many items to keep from this feed per run. Ten by default. */
  limit?: number;
};

/** What one feed did in a run. A failing feed is recorded, not thrown: the other feeds still land. */
export type StoryFetchSource = {
  id: string;
  ok: boolean;
  added: number;
  skipped: number;
  /** Why this feed failed: an HTTP status, a timeout, or the first line of the error. */
  error?: string;
};

/** What the last triage run did. `error` is how a client learns relevance is unavailable rather than zero. */
export type StoryTriage = {
  at: number;
  /** The topics the run judged against, copied so the scores stay interpretable after the topics change. */
  topics: string[];
  scored: number;
  /** Candidates this run left for the next one, because a run is capped. */
  deferred: number;
  /** Candidates a classifier call failed on, and why. */
  failed: number;
  error?: string;
};

/** What the last fetch run did, stored on the list so a client can render it without reading a task. */
export type StoryFetch = {
  at: number;
  added: number;
  skipped: number;
  sources: StoryFetchSource[];
};

/** What the last digest run saw, stored on the list so a client can render it without reading a task. */
export type StoryDigest = {
  run: number;
  at: number;
  open: number;
  ranked: number;
  /** The highest-scored story, when the list has one. */
  top?: string;
};

export type StoriesDoc = {
  items: Story[];
  /** How many digest runs this list has seen; the next run's number. */
  runs: number;
  digest?: StoryDigest;
  fetch?: StoryFetch;
  /**
   * What this list is for, in words: "durable execution, local-first sync". Triage judges against it, and without it
   * there is nothing to be relevant to, so a run records that instead of inventing a criterion.
   */
  topics?: string[];
  triage?: StoryTriage;
};
