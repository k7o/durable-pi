import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, type SessionRow } from "../src/catalog.js";
import { ChangeFeed } from "../src/changes.js";
import { Compaction } from "../src/compaction.js";
import { Models } from "../src/models.js";

const row: SessionRow = {
  id: "s1",
  name: "First",
  cwd: "/work",
  dbPath: "/work/s1/agent.sqlite",
  createdAt: 1,
  model: "echo",
  provider: "faux",
};

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-compaction-"));
  const changes = new ChangeFeed();
  const catalog = await Catalog.open(dir, changes);
  catalog.insertSession(row);
  const models = await Models.open("faux");
  return {
    catalog,
    compaction: new Compaction(catalog, models),
    modelWindow: models.windowOf("echo"),
    cleanup: async () => {
      await catalog.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("compaction: a session starts on its model's defaults", async () => {
  const t = await temp();
  try {
    assert.equal(t.modelWindow, 128000);
    assert.deepEqual(t.compaction.get("s1"), {
      enabled: true,
      reserveTokens: 16384,
      backgroundTokens: 32768,
      keepRecentTokens: 2000,
    });
  } finally {
    await t.cleanup();
  }
});

test("compaction: saves validated thresholds and reads them back", async () => {
  const t = await temp();
  try {
    const saved = t.compaction.set(row, { reserveTokens: 4096, backgroundTokens: 2048, keepRecentTokens: 1500 });
    assert.deepEqual(saved, {
      enabled: true,
      reserveTokens: 4096,
      backgroundTokens: 2048,
      keepRecentTokens: 1500,
    });
    assert.deepEqual(t.catalog.compactionSettings("s1"), saved);
    assert.deepEqual(t.compaction.get("s1"), saved);

    assert.throws(() => t.compaction.set(row, { reserveTokens: 10 }), /reserveTokens must be an integer/);
    assert.throws(() => t.compaction.set(row, { enabled: "yes" }), /enabled must be a boolean/);
  } finally {
    await t.cleanup();
  }
});

test("compaction: refits thresholds that do not fit a smaller model window", async () => {
  const t = await temp();
  try {
    t.compaction.set(row, { reserveTokens: 1_000_000 });
    t.compaction.refitFor("s1", "echo");
    assert.deepEqual(t.compaction.get("s1"), {
      enabled: true,
      reserveTokens: 16384,
      backgroundTokens: 32768,
      keepRecentTokens: 2000,
    });

    t.compaction.set(row, { reserveTokens: 8192 });
    t.compaction.refitFor("s1", "echo");
    assert.equal(t.compaction.get("s1").reserveTokens, 8192, "thresholds that fit are left alone");
  } finally {
    await t.cleanup();
  }
});

test("compaction: forgetting a session clears the cache", async () => {
  const t = await temp();
  try {
    t.compaction.set(row, { reserveTokens: 4096 });
    assert.equal(t.compaction.get("s1").reserveTokens, 4096);
    t.catalog.forgetSession("s1");
    t.compaction.forget("s1");
    assert.equal(t.catalog.compactionSettings("s1"), null, "the archived session's row goes with it");
    assert.deepEqual(t.compaction.get("s1"), {
      enabled: true,
      reserveTokens: 16384,
      backgroundTokens: 32768,
      keepRecentTokens: 2000,
    });
  } finally {
    await t.cleanup();
  }
});
