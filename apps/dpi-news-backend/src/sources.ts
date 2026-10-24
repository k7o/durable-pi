// Where a fetch run reads from, and the parser that turns a feed into stories.
//
// Feeds, not pages. Every news site a person would name publishes RSS or Atom, the markup is stable and machine-readable,
// and a feed is a site saying "here is a list you may read" — where scraping an article page means guessing at markup that
// changes and deciding for yourself what their terms allow. So the run reads feeds, and `parseFeed` handles exactly the
// two formats: RSS 2.0 `<item>` and Atom `<entry>`.
//
// No dependencies on purpose. This is one product's job in an app that has no third-party runtime deps of its own, and a
// feed parser for two formats is a hundred lines that a test can pin. It is deliberately unambitious: no namespaces, no
// nested content, first match wins. A feed it cannot read fails loudly (a story with no title is dropped, and a feed
// with no items is reported as an error by the run) rather than producing half-parsed junk.
import type { StorySource } from "../../dpi-sdk/src/packs/news.js";

/**
 * The feeds a news device reads when nothing else is configured. Chosen for being public, stable and short — the run caps
 * how many items it keeps, so a firehose cannot bury the list. Change this list, or pass `sources` when a run is started,
 * and remember the sandbox's network policy has to allow each host (`sbx/durable.yaml`).
 */
export const DEFAULT_SOURCES: readonly StorySource[] = [
  { id: "hn", name: "Hacker News", url: "https://hnrss.org/frontpage", limit: 10 },
  { id: "lobsters", name: "Lobsters", url: "https://lobste.rs/rss", limit: 10 },
  { id: "verge", name: "The Verge", url: "https://www.theverge.com/rss/index.xml", limit: 10 },
];

export type FeedItem = { title: string; url?: string; publishedAt?: number };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#8217": "’",
  "#8216": "‘",
  "#8220": "“",
  "#8221": "”",
  "#8212": "—",
  "#8230": "…",
};

/** Entities and CDATA are the two things that make feed titles read as markup instead of text. */
export function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    // Strip real markup *before* decoding: `&lt;b&gt;` is text a feed escaped on purpose, and decoding first
    // would turn it into a tag that this line then deletes.
    .replace(/<[^>]*>/gu, "")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z#0-9]+);/giu, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/gu, " ")
    .trim();
}

/** The text of the first `<tag>` inside `chunk`, decoded; `undefined` when the tag is absent or empty. */
function tag(chunk: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "iu").exec(chunk);
    const value = found?.[1] === undefined ? undefined : decode(found[1]);
    if (value) return value;
  }
  return undefined;
}

/** RSS carries the link as text, Atom as an attribute, and either may be relative to the feed. */
function link(chunk: string): string | undefined {
  const rss = tag(chunk, "link");
  if (rss) return rss;
  const href = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/iu.exec(chunk)?.[1];
  return href ? decode(href) : undefined;
}

/** `Date.parse` returns NaN for the formats feeds use when they are sloppy, so an unreadable date is simply absent. */
function date(...values: (string | undefined)[]): number | undefined {
  for (const value of values) {
    if (!value) continue;
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return at;
  }
  return undefined;
}

const absolute = (url: string, base: string): string => {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
};

/**
 * The stories in one feed, in feed order, deduplicated by link, capped at the source's limit. A `<item>`/`<entry>` with no
 * title is dropped rather than rendered blank; a feed with no readable items at all yields an empty array, and the run
 * treats that as a failure worth reporting (an empty feed and an HTML error page both look like "nothing here" otherwise).
 */
export function parseFeed(xml: string, source: StorySource): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/giu)].map((match) => match[0]);
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const title = tag(block, "title");
    if (!title) continue;
    const href = link(block);
    const url = href ? absolute(href, source.url) : undefined;
    // A feed that repeats a link (they do, across sections) is one story, not two.
    if (url) {
      if (seen.has(url)) continue;
      seen.add(url);
    } else if (seen.has(title)) continue;
    else seen.add(title);
    const publishedAt = date(tag(block, "pubDate", "published", "updated", "dc:date"));
    items.push({ title, ...(url ? { url } : {}), ...(publishedAt ? { publishedAt } : {}) });
    if (items.length >= (source.limit ?? 10)) break;
  }
  return items;
}
