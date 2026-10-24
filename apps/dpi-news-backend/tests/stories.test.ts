// The whole vertical slice, driven the way an agent and the engine drive it: add, list, rank through the tool, then a
// digest run that commits its summary onto the same document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STORIES_DOC, type StoriesDoc } from "../../dpi-sdk/src/news.js";
import type { Device } from "../../dpi-backend/src/device.js";
import { callTool, faux, tempDevice, until } from "./helpers.js";

const stories = async (store: Device, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return (await store.agentDoc(h, c, STORIES_DOC)) as StoriesDoc;
};

test("news desk: a story is added, ranked, and summarised by a digest run", async () => {
  const t = await tempDevice();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Desk", cwd: t.work, model: faux });

    // Nothing exists yet, and the document is served before the tool ever writes it.
    assert.deepEqual(await stories(store, session.id), { items: [], runs: 0 });
    assert.equal(JSON.parse(await callTool(store, session.id, { action: "list" })).open, 0);

    const added = await callTool(store, session.id, { action: "add", title: "A durable story", url: "https://example.com/a" });
    assert.match(added, /^Added s\d+: A durable story$/);
    const id = added.slice("Added ".length, added.indexOf(":"));
    const listed = JSON.parse(await callTool(store, session.id, { action: "list" }));
    assert.equal(listed.open, 1);
    assert.deepEqual(listed.items.map((s: { id: string; title: string }) => [s.id, s.title]), [[id, "A durable story"]]);
    assert.equal(listed.items[0].url, "https://example.com/a");

    await assert.rejects(() => callTool(store, session.id, { action: "add", title: "  " }), /add needs a title/);
    await assert.rejects(() => callTool(store, session.id, { action: "add", title: "x", url: "ftp://nope" }), /http/);
    await assert.rejects(() => callTool(store, session.id, { action: "rank", id: "s0", score: 10 }), /No story s0/);
    await assert.rejects(() => callTool(store, session.id, { action: "rank", id }), /rank needs a score/);

    const ranked = await callTool(store, session.id, { action: "rank", id, score: 73.4 });
    assert.equal(ranked, `Ranked ${id} at 73: A durable story`);
    assert.equal((await stories(store, session.id)).items[0].score, 73);

    // A digest run is its own durable task; once it commits, the summary is on the list under the same document.
    const started = await callTool(store, session.id, { action: "digest" });
    assert.match(started, /Started digest run as durable task #\d+/);
    await until(async () => (await stories(store, session.id)).digest !== undefined, 20000, "the digest run");
    const doc = await stories(store, session.id);
    assert.equal(doc.runs, 1);
    assert.deepEqual(
      { run: doc.digest?.run, open: doc.digest?.open, ranked: doc.digest?.ranked, top: doc.digest?.top },
      { run: 1, open: 0, ranked: 1, top: "A durable story" },
    );

    // The run also recorded itself in the device's App State, under the app's own key, so the two packs can share one
    // document: the digest is the fact about the device, the list is the fact about the conversation.
    const shared = await store.appState.snapshot();
    assert.deepEqual(shared.value.news, { run: 1, at: doc.digest?.at, open: 0, ranked: 1, top: "A durable story" });

    // A second run counts up on the same document instead of starting over.
    await callTool(store, session.id, { action: "add", title: "A second story" });
    await callTool(store, session.id, { action: "digest" });
    await until(async () => (await stories(store, session.id)).runs === 2, 20000, "the second digest run");
    const second = await stories(store, session.id);
    assert.equal(second.digest?.open, 1);
    assert.equal(second.digest?.ranked, 1);
    assert.equal(second.digest?.top, "A durable story", "the ranked story stays on top");

    // The list is conversation-scoped: another conversation starts empty.
    const other = await store.create({ name: "Other desk", cwd: t.work, model: faux });
    assert.deepEqual(await stories(store, other.id), { items: [], runs: 0 });
  } finally {
    await store.close();
    await t.cleanup();
  }
});
