// The fetch run, end to end: a local server plays three news sites — one RSS, one Atom, one broken — and the run reads
// them the way it reads the real thing, through the tool that starts it.
//
// Nothing here touches the network. The feeds are strings in this file served on a loopback port, which is also what
// makes the failure cases reproducible: a 500 is one line, not a website having a bad day.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Device } from "../../dpi-backend/src/device.js";
import { STORIES_DOC, type StoriesDoc, type StorySource } from "../../dpi-sdk/src/packs/news.js";
import { decode, parseFeed } from "../src/sources.js";
import { callTool, faux, tempDevice, until } from "./helpers.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed A</title>
  <item><title><![CDATA[A durable agent &amp; you]]></title><link>/a/one</link><pubDate>Wed, 22 Oct 2026 09:00:00 GMT</pubDate></item>
  <item><title>Second story</title><link>https://example.com/a/two</link></item>
  <item><title>Second story</title><link>https://example.com/a/two</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed B</title>
  <entry><title>An atom story</title><link rel="alternate" href="https://example.com/b/one"/><updated>2026-10-21T12:00:00Z</updated></entry>
  <entry><title>No link here</title></entry>
</feed>`;

const sources = (base: string): StorySource[] => [
  { id: "a", name: "Feed A", url: `${base}/rss` },
  { id: "b", name: "Feed B", url: `${base}/atom` },
  { id: "c", name: "Feed C", url: `${base}/broken` },
];

const stories = async (store: Device, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return (await store.agentDoc(h, c, STORIES_DOC)) as StoriesDoc;
};

/** A server whose routes are the three feeds, plus the port it ended up on. */
async function feedServer() {
  const server = createServer((req, res) => {
    if (req.url === "/rss") {
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(RSS);
    } else if (req.url === "/atom") {
      res.writeHead(200, { "content-type": "application/atom+xml" }).end(ATOM);
    } else {
      res.writeHead(500, { "content-type": "text/plain" }).end("upstream is on fire");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((done) => server.close(() => done())) };
}

test("sources: a feed becomes stories, decoded, deduplicated and made absolute", () => {
  const rss = parseFeed(RSS, { id: "a", name: "Feed A", url: "https://example.com/feed.xml" });
  assert.deepEqual(rss, [
    { title: "A durable agent & you", url: "https://example.com/a/one", publishedAt: Date.parse("Wed, 22 Oct 2026 09:00:00 GMT") },
    // The feed repeats this link, so it is one story.
    { title: "Second story", url: "https://example.com/a/two" },
  ]);

  const atom = parseFeed(ATOM, { id: "b", name: "Feed B", url: "https://example.com/atom.xml" });
  assert.deepEqual(atom, [
    { title: "An atom story", url: "https://example.com/b/one", publishedAt: Date.parse("2026-10-21T12:00:00Z") },
    { title: "No link here" },
  ]);

  // A feed that is not a feed: the run turns this into a failed source rather than adding nothing and looking healthy.
  assert.deepEqual(parseFeed("<html><body>nope</body></html>", { id: "c", name: "C", url: "https://example.com" }), []);
  // The cap applies after deduplication, so `limit` is a number of stories, not of lines in the file.
  assert.equal(parseFeed(RSS, { id: "a", name: "A", url: "https://example.com", limit: 1 }).length, 1);
  assert.equal(decode("a &lt;b&gt; c &#8212; d"), "a <b> c — d");
});

test("news desk: a fetch run reads the feeds, keeps what is new, and reports the broken one", async () => {
  const site = await feedServer();
  const t = await tempDevice({ sources: sources(site.base) });
  const store = await t.open();
  try {
    const session = await store.create({ name: "Desk", cwd: t.work, model: faux });

    const started = await callTool(store, session.id, { action: "fetch" }, { sources: sources(site.base) });
    assert.match(started, /^Started fetch run as durable task #\d+\./);
    await until(async () => (await stories(store, session.id)).fetch !== undefined, 30_000, "the fetch run");

    const doc = await stories(store, session.id);
    assert.equal(doc.fetch?.added, 4, "two unique from RSS, two from Atom (the duplicate link and the failed feed add nothing)");
    assert.equal(doc.fetch?.skipped, 0);
    assert.deepEqual(
      doc.items.map((story) => [story.title, story.source]),
      [
        ["A durable agent & you", "a"],
        ["Second story", "a"],
        ["An atom story", "b"],
        ["No link here", "b"],
      ],
    );
    // Both link shapes resolve: RSS text against the feed URL, Atom href as it stands.
    assert.deepEqual(doc.items.map((story) => story.url), [
      `${site.base}/a/one`,
      "https://example.com/a/two",
      "https://example.com/b/one",
      // An entry with no link is still a story, and its title is what a second run dedupes on.
      undefined,
    ]);
    assert.deepEqual(doc.fetch?.sources, [
      { id: "a", ok: true, added: 2, skipped: 0 },
      { id: "b", ok: true, added: 2, skipped: 0 },
      { id: "c", ok: false, added: 0, skipped: 0, error: "HTTP 500: upstream is on fire" },
    ]);
    // Ids are the run's task id plus a position, so a retried commit cannot mint a second id for one story.
    assert.ok(doc.items.every((story) => /^f\d+-\d+$/u.test(story.id)));

    // Running it again over unchanged feeds adds nothing: that is what makes a timer safe.
    await callTool(store, session.id, { action: "fetch" }, { sources: sources(site.base) });
    await until(async () => (await stories(store, session.id)).fetch?.at !== doc.fetch?.at, 30_000, "the second run");
    const second = await stories(store, session.id);
    assert.equal(second.items.length, 4);
    assert.equal(second.fetch?.added, 0);
    assert.equal(second.fetch?.skipped, 4);
    // The list is the same length and the digest counter is untouched by a fetch: only a digest run increments it.
    assert.equal(second.runs, 0);
    assert.deepEqual(JSON.parse(await callTool(store, session.id, { action: "list" })).fetch.added, 0);
  } finally {
    await store.close();
    await site.stop();
    await t.cleanup();
  }
});
