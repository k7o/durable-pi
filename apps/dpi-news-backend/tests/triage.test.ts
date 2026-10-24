// Relevance, end to end with a stand-in classifier: the judgement is a function this test supplies, so the run's own
// behaviour is what is under test — what it asks, what it writes, what it refuses to do when it cannot judge.
//
// The classifier here is deliberately dumb (score 84 when the story mentions a topic, 12 when it does not) so an assertion
// can tell a real answer from a default, and one case makes it throw, which is the state a device with no classifier or an
// unreachable Jev is in.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Device } from "../../dpi-backend/src/device.js";
import type { Classify } from "../../dpi-backend/src/pack-api.js";
import { STORIES_DOC, type StoriesDoc } from "../../dpi-sdk/src/packs/news.js";
import { callTool, faux, tempDevice, until } from "./helpers.js";

const stories = async (store: Device, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return (await store.agentDoc(h, c, STORIES_DOC)) as StoriesDoc;
};

/** Mentions "durable" → 0.84 (a 0..1 service), otherwise 12 (a 0..100 service): both scales are real. */
const scored: Classify = async (context) => {
  const title = String((context.state as { title?: unknown }).title ?? "");
  const score = title.toLowerCase().includes("durable") ? 0.84 : 12;
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers: { relevance: { type: "score", score, confidence: 0.9 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
};

const failing: Classify = async () => {
  throw Error("jev is unreachable");
};

test("news desk: triage scores the unjudged stories against the list's topics, and keeps them", async () => {
  const t = await tempDevice({ classify: scored });
  const store = await t.open();
  try {
    const session = await store.create({ name: "Desk", cwd: t.work, model: faux });

    // Two stories: one the classifier will call relevant, one it will not — plus one added by hand, which is already a
    // judgment by the agent and must not be re-judged.
    await callTool(store, session.id, { action: "add", title: "A durable execution story", url: "https://example.com/a" });
    await callTool(store, session.id, { action: "add", title: "A celebrity story", url: "https://example.com/b" });
    const agentAdded = (await stories(store, session.id)).items[0].id;

    // Without topics there is nothing to be relevant to: the run records that instead of inventing a criterion.
    assert.match(await callTool(store, session.id, { action: "triage" }), /^Started triage run/);
    await until(async () => (await stories(store, session.id)).triage !== undefined, 20_000, "the first triage run");
    const empty = await stories(store, session.id);
    assert.match(empty.triage?.error ?? "", /no topics/);
    assert.equal(empty.triage?.scored, 0);
    assert.ok(empty.items.every((story) => story.relevance === undefined), "nothing judged, nothing defaulted to zero");

    // With topics, the run judges every unjudged story: the fetched/added ones, not the one a person ranked.
    await callTool(store, session.id, { action: "topics", topics: ["durable execution", "agent runtimes"] });
    await callTool(store, session.id, { action: "rank", id: agentAdded, score: 90 });
    await callTool(store, session.id, { action: "triage" });
    await until(async () => (await stories(store, session.id)).triage?.scored === 1, 20_000, "the second triage run");

    const judged = await stories(store, session.id);
    assert.deepEqual(judged.topics, ["durable execution", "agent runtimes"]);
    assert.deepEqual(
      judged.items.map((story) => [story.title, story.relevance ?? story.score]),
      [
        ["A durable execution story", 90],
        ["A celebrity story", 12],
      ],
    );
    // The 0..1 answer was scaled to a percentage, and the service that gave it is on the story.
    assert.equal(judged.items[1].relevanceBy?.model, "jev-latest");
    assert.equal(judged.triage?.topics[0], "durable execution");
    assert.equal(judged.triage?.failed, 0);
    assert.equal(judged.items.length, 2, "scoring is not deleting");

    // A second run has nothing left to judge, and says so rather than re-spending the calls.
    await callTool(store, session.id, { action: "triage" });
    await until(async () => /nothing left/.test((await stories(store, session.id)).triage?.error ?? ""), 20_000, "the idempotent run");
    const again = JSON.parse(await callTool(store, session.id, { action: "list" }));
    assert.equal(again.triage.scored, 0);
    assert.deepEqual(again.items.map((story: { relevance?: number }) => story.relevance), [undefined, 12]);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("news desk: a classifier that fails leaves the stories unjudged and says why", async () => {
  const t = await tempDevice({ classify: failing });
  const store = await t.open();
  try {
    const session = await store.create({ name: "Desk", cwd: t.work, model: faux });
    await callTool(store, session.id, { action: "add", title: "A durable execution story", url: "https://example.com/a" });
    await callTool(store, session.id, { action: "topics", topics: ["durable execution"] });
    await callTool(store, session.id, { action: "triage" });
    await until(async () => (await stories(store, session.id)).triage !== undefined, 20_000, "the failing triage run");

    const doc = await stories(store, session.id);
    assert.equal(doc.triage?.error, "jev is unreachable");
    assert.equal(doc.triage?.scored, 0);
    assert.equal(doc.triage?.failed, 1);
    // Fail open: the story is still there, unjudged, rather than dropped or scored zero by default.
    assert.equal(doc.items.length, 1);
    assert.equal(doc.items[0].relevance, undefined);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
