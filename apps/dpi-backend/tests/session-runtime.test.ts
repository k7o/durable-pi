import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, type SessionRow } from "../src/catalog.js";
import { ChangeFeed } from "../src/changes.js";
import { Compaction } from "../src/compaction.js";
import { fauxModels } from "./faux.js";
import { SessionRuntime } from "../src/session-runtime.js";
import { Documents } from "../src/documents.js";
import { EMPTY_PACK } from "../src/pack.js";

async function tempRuntime() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-runtime-")));
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
      throw Error("the runtime test never spawns a session");
    },
    archiveDir: join(root, "data", "archive"),
    startDirs: [work],
    name: "test",
  });
  const row = (id: string, name: string): SessionRow => ({
    id,
    name,
    cwd: work,
    dbPath: join(root, "data", "sessions", id, "agent.sqlite"),
    createdAt: Date.now(),
    model: "echo",
    provider: "faux",
  });
  return {
    root,
    work,
    catalog,
    runtime,
    row,
    cleanup: async () => {
      await runtime.close();
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("session runtime: opens a session's harness, then closes it", async () => {
  const t = await tempRuntime();
  try {
    const row = t.row("s1", "First");
    assert.equal(t.runtime.isOpen("s1"), false);
    const harness = await t.runtime.open(row, true);
    assert.equal(t.runtime.isOpen("s1"), true);
    assert.equal(t.runtime.harness(row), harness);

    await t.runtime.close();
    assert.equal(t.runtime.isOpen("s1"), false);
  } finally {
    await t.cleanup();
  }
});

test("session runtime: archive stops work, keeps the files and forgets the session", async () => {
  const t = await tempRuntime();
  try {
    const row = t.row("s1", "First");
    await t.runtime.open(row, true);
    t.catalog.insertSession(row);
    t.catalog.setCompactionSettings("s1", { reserveTokens: 4096 });

    const { archived } = await t.runtime.archive(row);
    assert.equal(t.runtime.isOpen("s1"), false);
    assert.equal(t.catalog.getSession("s1"), undefined);
    assert.equal(t.catalog.compactionSettings("s1"), null);
    assert.equal(existsSync(join(archived, "agent.sqlite")), true);
    assert.equal(existsSync(row.dbPath), false);
  } finally {
    await t.cleanup();
  }
});

test("session runtime: a session that cannot open reports unavailable", async () => {
  const t = await tempRuntime();
  try {
    const bad = t.row("bad", "Broken");
    t.catalog.insertSession(bad);
    await t.runtime.openAll([bad], { create: false });
    assert.throws(() => t.runtime.harness(bad), /Session Broken is unavailable/);
    assert.equal(t.runtime.isOpen("bad"), false);
  } finally {
    await t.cleanup();
  }
});

test("session runtime: browses the device's starting folders", async () => {
  const t = await tempRuntime();
  try {
    const roots = await t.runtime.directories();
    assert.deepEqual(roots.dirs.map((d) => d.path), [t.work]);
    await mkdir(join(t.work, "project"));
    const listing = await t.runtime.browse(t.work);
    assert.deepEqual(listing.dirs.map((d) => d.name), ["project"]);
  } finally {
    await t.cleanup();
  }
});

test("session runtime: resolves a session cwd against the first start dir", async () => {
  const t = await tempRuntime();
  try {
    await mkdir(join(t.work, "project"));
    assert.equal(await t.runtime.resolveCwd("project"), join(t.work, "project"));
    assert.equal(await t.runtime.resolveCwd("~"), (await import("node:os")).homedir());
    await assert.rejects(() => t.runtime.resolveCwd("missing"), /cwd must be an existing folder/);
  } finally {
    await t.cleanup();
  }
});
