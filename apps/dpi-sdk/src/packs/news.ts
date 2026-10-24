// The news pack's story list, as clients read it: one durable story list per conversation, served at
// `news.stories`, plus the last digest a run wrote onto it. Belongs to the news pack; see `demo-jobs.ts` for the rule. Types are aliases (not interfaces) so they stay JSON documents. The document itself is
// defined next to the tool that edits it (`apps/dpi-news-backend/src/stories.ts`).

export const STORIES_DOC = "news.stories";

export type Story = {
  /** `s<taskId>` of the tool call that added it, so a replay cannot add the same story twice. */
  id: string;
  title: string;
  url?: string;
  /** 0 to 100 once someone ranked it; absent means it is still waiting for a look. */
  score?: number;
  addedAt: number;
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
};
