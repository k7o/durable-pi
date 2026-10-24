import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { InboxDoc } from "@earendil-works/pi-durable";
import { Catalog, type SessionRow } from "../src/catalog.js";
import { ChangeFeed } from "../src/changes.js";
import { Compaction } from "../src/compaction.js";
import { Conversations } from "../src/conversations.js";
import { fauxModels } from "./faux.js";
import { SessionRuntime } from "../src/session-runtime.js";
import { Documents } from "../src/documents.js";
import { EMPTY_PACK } from "../src/pack.js";

async function tempConversation() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-conv-")));
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const changes = new ChangeFeed();
  const catalog = await Catalog.open(join(root, "data"), changes);
  const models = await fauxModels();
  const runtime = new SessionRuntime({
    catalog,
    models,
    compaction: new Compaction(catalog, models),
    changes,
    pack: EMPTY_PACK,
    documents: new Documents(EMPTY_PACK),
    spawn: async () => {
      throw Error("unused");
    },
    archiveDir: join(root, "data", "archive"),
    startDirs: [work],
    name: "test",
  });
  const row: SessionRow = {
    id: "s1",
    name: "First",
    cwd: work,
    dbPath: join(root, "data", "sessions", "s1", "agent.sqlite"),
    createdAt: Date.now(),
    model: "echo",
    provider: "faux",
  };
  const h = await runtime.open(row, true);
  const c = await h.root(ctx);
  return {
    h,
    c,
    conversations: new Conversations(),
    cleanup: async () => {
      await runtime.close();
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("conversations: accepts an input, settles it and reads the transcript", async () => {
  const t = await tempConversation();
  try {
    const submission = await t.conversations.send(t.c, { content: "hello", requestId: "r1" });
    const result = await t.conversations.settled(t.h, submission.id as number, 20000);
    assert.equal(result.status, "done");
    assert.match(result.status === "done" ? result.answer.text : "", /Echo: hello/);

    const active = await t.conversations.activeEntries(t.c);
    assert.ok(active.length >= 2);
    const markdown = await t.conversations.transcript(t.c, "markdown");
    assert.match((markdown as { text: string }).text, /Echo: hello/);
    const json = await t.conversations.transcript(t.c, "json");
    assert.ok(Array.isArray((json as { items: unknown[] }).items));

    const page = await t.conversations.entries(t.c, undefined, 1);
    assert.equal(page.items.length, 1);
    assert.ok(page.next, "a cursor follows a partial page");
    const next = await t.conversations.entries(t.c, page.next, 1);
    assert.equal(next.items.length, 1);

    assert.deepEqual(await t.conversations.inbox(t.h, t.c), []);
  } finally {
    await t.cleanup();
  }
});

test("conversations: coerces queued inbox content to text", async () => {
  const t = await tempConversation();
  try {
    await t.h.commit(async (tx) => {
      const doc = await tx.doc(InboxDoc, t.c.id);
      doc.items = [
        { id: 1, mode: "followUp", content: "plain text" },
        {
          id: 2,
          mode: "steer",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
        { id: 3, mode: "write", content: "replaced context" },
      ] as never;
    }, ctx);
    assert.deepEqual(await t.conversations.inbox(t.h, t.c), [
      { id: 1, mode: "followUp", content: "plain text" },
      { id: 2, mode: "steer", content: "ab" },
      { id: 3, mode: "write", content: "Context update" },
    ]);
  } finally {
    await t.cleanup();
  }
});

test("conversations: aborts a run in progress", async () => {
  const t = await tempConversation();
  try {
    const submission = await t.conversations.send(t.c, {
      content: `slow: ${"x".repeat(400)}`,
      requestId: "slow-1",
    });
    await t.conversations.abort(t.c, false);
    const result = await t.conversations.settled(t.h, submission.id as number, 20000);
    assert.notEqual(result.status, "done");
  } finally {
    await t.cleanup();
  }
});

test("conversations: maps a task graph node to the wire shape", () => {
  const conversations = new Conversations();
  assert.deepEqual(
    conversations.taskNode({
      id: 7,
      kind: "pi.tool",
      conversationId: 1,
      owner: 3,
      background: true,
      abortRequested: true,
      state: { status: "running", phase: "call", on: [1, 2], policy: "wait" },
      conversations: [1, 2],
      outcome: "dropped",
    }),
    {
      id: 7,
      kind: "pi.tool",
      conversationId: 1,
      owner: 3,
      background: true,
      aborting: true,
      state: { status: "running", phase: "call", on: [1, 2], policy: "wait" },
      conversations: [1, 2],
    },
  );
});
