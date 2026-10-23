import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, type SessionRow } from "../src/catalog.js";
import { ChangeFeed } from "../src/changes.js";

async function tempCatalog() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-catalog-"));
  return { dir, changes: new ChangeFeed(), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const row = (id: string, name: string, createdAt = 1): SessionRow => ({
  id,
  name,
  cwd: "/work",
  dbPath: `/work/${id}/agent.sqlite`,
  createdAt,
  model: "echo",
  provider: "faux",
});

test("catalog: keeps the device uid and session rows across a reopen", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    let notified = 0;
    const off = t.changes.subscribe(() => notified++);
    const first = row("s1", "First");
    catalog.insertSession(first);

    assert.equal(typeof catalog.deviceUid, "string");
    assert.equal(catalog.deviceUid.length, 36);
    assert.deepEqual(catalog.listSessions(), [first]);
    assert.deepEqual(catalog.getSession("s1"), first);
    assert.equal(catalog.getSession("missing"), undefined);
    assert.equal(notified, 1, "insert notifies");
    off();
    const uid = catalog.deviceUid;
    await catalog.close();

    const reopened = await Catalog.open(t.dir, t.changes);
    assert.equal(reopened.deviceUid, uid);
    assert.deepEqual(reopened.listSessions(), [first]);
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: resolves a session by id or unique name, and refuses ambiguous names", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    catalog.insertSession(row("s1", "Alpha"));
    catalog.insertSession(row("s2", "Beta"));
    catalog.insertSession(row("s3", "beta"));

    assert.equal(catalog.resolveSession("s1").id, "s1");
    assert.equal(catalog.resolveSession("Alpha").id, "s1");
    assert.throws(() => catalog.resolveSession("missing"), (e: { code?: string }) => e.code === "not_found");
    assert.throws(() => catalog.resolveSession("BETA"), (e: { code?: string }) => e.code === "ambiguous");
    await catalog.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: renames and forgets sessions, and stores agent names", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    let notified = 0;
    catalog.insertSession(row("s1", "First"));
    const off = t.changes.subscribe(() => notified++);

    catalog.renameSession("s1", "Renamed");
    assert.equal(catalog.getSession("s1")?.name, "Renamed");
    assert.equal(notified, 1, "rename notifies");

    catalog.setAgentName("s1", 2, "Helper");
    catalog.setAgentName("s1", 2, "Helper 2");
    catalog.setAgentName("s1", 3, "Other");
    assert.deepEqual([...catalog.agentNames("s1")], [[2, "Helper 2"], [3, "Other"]]);
    assert.equal(notified, 4, "each agent name write notifies");

    catalog.forgetSession("s1");
    assert.equal(catalog.getSession("s1"), undefined);
    assert.deepEqual(catalog.listSessions(), []);
    assert.equal(catalog.agentNames("s1").size, 0);
    assert.equal(notified, 5, "forget notifies");
    off();
    await catalog.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: stores the session model chosen by the root agent", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    catalog.insertSession(row("s1", "First"));
    catalog.setSessionModel("s1", { provider: "faux", modelId: "echo-2" });
    assert.equal(catalog.getSession("s1")?.model, "echo-2");
    assert.equal(catalog.getSession("s1")?.provider, "faux");
    await catalog.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: stores per-session compaction settings and clears them on request", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    catalog.insertSession(row("s1", "First"));
    assert.equal(catalog.compactionSettings("s1"), null);

    catalog.setCompactionSettings("s1", { reserveTokens: 1000, enabled: false });
    assert.deepEqual(catalog.compactionSettings("s1"), { reserveTokens: 1000, enabled: false });
    await catalog.close();

    const reopened = await Catalog.open(t.dir, t.changes);
    assert.deepEqual(reopened.compactionSettings("s1"), { reserveTokens: 1000, enabled: false });
    reopened.setCompactionSettings("s1", null);
    assert.equal(reopened.compactionSettings("s1"), null);
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: replays a stored response only for the same route", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    assert.equal(catalog.replay("k1", "POST /v1/sessions"), undefined);
    catalog.remember("k1", "POST /v1/sessions", 201, { id: "s1" });
    assert.deepEqual(catalog.replay("k1", "POST /v1/sessions"), { status: 201, body: { id: "s1" } });
    assert.throws(
      () => catalog.replay("k1", "POST /v1/sessions/x/agents"),
      (e: { code?: string }) => e.code === "invalid",
    );
    await catalog.close();

    const reopened = await Catalog.open(t.dir, t.changes);
    assert.deepEqual(reopened.replay("k1", "POST /v1/sessions"), { status: 201, body: { id: "s1" } });
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: records which tool call started a session", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    catalog.insertSession(row("s1", "First"), "tool-call-1");
    assert.equal(catalog.spawnOwner("tool-call-1"), "s1");
    assert.equal(catalog.spawnOwner("other"), undefined);
    catalog.recordSpawn("tool-call-1", "s2");
    assert.equal(catalog.spawnOwner("tool-call-1"), "s2", "a recorded key replaces the old owner");
    await catalog.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: one open owns the file, and closing releases it", async () => {
  const t = await tempCatalog();
  try {
    const first = await Catalog.open(t.dir, t.changes);
    await assert.rejects(() => Catalog.open(t.dir, t.changes), /Database already owned/);
    await first.close();
    const second = await Catalog.open(t.dir, t.changes);
    await second.close();
  } finally {
    await t.cleanup();
  }
});

test("catalog: drops idempotency keys older than 24 hours on open", async () => {
  const t = await tempCatalog();
  try {
    const catalog = await Catalog.open(t.dir, t.changes);
    catalog.remember("fresh", "POST /v1/sessions", 201, { id: "s1" });
    await catalog.close();

    // Age the row out of band, as a device that has been offline would find it.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(t.dir, "catalog.sqlite"));
    db.prepare("INSERT INTO requests VALUES(?,?,?,?,?)").run(
      "stale",
      "POST /v1/sessions",
      201,
      "{}",
      Date.now() - 24 * 3600_000 - 1,
    );
    db.close();

    const reopened = await Catalog.open(t.dir, t.changes);
    assert.deepEqual(reopened.replay("fresh", "POST /v1/sessions"), { status: 201, body: { id: "s1" } });
    assert.equal(reopened.replay("stale", "POST /v1/sessions"), undefined);
    await reopened.close();
  } finally {
    await t.cleanup();
  }
});
