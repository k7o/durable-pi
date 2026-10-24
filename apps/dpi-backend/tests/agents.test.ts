import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, type SessionRow } from "../src/catalog.js";
import { ChangeFeed } from "../src/changes.js";
import { Compaction } from "../src/compaction.js";
import { Conversations } from "../src/conversations.js";
import { Agents } from "../src/agents.js";
import { Models } from "../src/models.js";
import { SessionRuntime } from "../src/session-runtime.js";
import { SharedState } from "../src/playground/shared-state.js";

async function tempAgents() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-agents-")));
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const changes = new ChangeFeed();
  const catalog = await Catalog.open(join(root, "data"), changes);
  const models = await Models.open("faux");
  const shared = await SharedState.open(join(root, "data", "app-state.sqlite"));
  const sessions = new SessionRuntime({
    catalog,
    models,
    compaction: new Compaction(catalog, models),
    changes,
    shared,
    spawn: async () => {
      throw Error("unused");
    },
    archiveDir: join(root, "data", "archive"),
    startDirs: [work],
    name: "test",
    offline: true,
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
  catalog.insertSession(row);
  await sessions.open(row, true);
  const compaction = new Compaction(catalog, models);
  const conversations = new Conversations();
  const agents = new Agents({ catalog, models, compaction, changes, sessions, conversations });
  return {
    agents,
    conversations,
    row,
    cleanup: async () => {
      await sessions.close();
      await shared.close();
      await catalog.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("agents: resolves the root by id, main and name, and lists it", async () => {
  const t = await tempAgents();
  try {
    const main = await t.agents.resolve("s1", "main");
    assert.equal(main.row.id, "s1");
    assert.equal((await t.agents.resolve("s1", "1")).c.id, main.c.id);
    assert.equal((await t.agents.resolve("s1", "Main")).c.id, main.c.id);
    await assert.rejects(() => t.agents.resolve("s1", "nope"), /No agent "nope"/);

    const list = await t.agents.list(t.row);
    assert.deepEqual(
      list.map((a) => ({ id: a.id, name: a.name, kind: a.kind, named: a.named })),
      [{ id: 1, name: "Main", kind: "root", named: false }],
    );
  } finally {
    await t.cleanup();
  }
});

test("agents: detail reports every tool, and read-only removes the writers", async () => {
  const t = await tempAgents();
  try {
    const { row, c } = await t.agents.resolve("s1", "main");
    const before = await t.agents.detail(row, c);
    assert.equal(before.config.readOnly, false);
    assert.equal(before.tools.find((tool) => tool.name === "bash")?.writes, true);
    assert.equal(before.tools.find((tool) => tool.name === "read")?.writes, false);

    const configured = await t.agents.configure(row, c, { readOnly: true });
    assert.equal(configured.readOnly, true);
    const after = await t.agents.detail(row, c);
    assert.deepEqual(
      after.tools.filter((tool) => tool.offered).map((tool) => tool.name).sort(),
      after.tools.filter((tool) => !tool.writes).map((tool) => tool.name).sort(),
    );

    assert.equal((await t.agents.configure(row, c, { readOnly: false })).readOnly, false);
  } finally {
    await t.cleanup();
  }
});

test("agents: forks and renames resolve by their new name", async () => {
  const t = await tempAgents();
  try {
    const { h, row, c } = await t.agents.resolve("s1", "main");
    const submission = await t.conversations.send(c, { content: "hello", requestId: "r1" });
    await t.conversations.settled(h, submission.id as number, 20000);
    const entries = await t.conversations.activeEntries(c);
    const fork = await t.agents.fork(row, c, { entryId: entries.at(-1)!.id, name: "Reviewer" });
    assert.equal(fork.kind, "fork");
    assert.equal(fork.name, "Reviewer");
    assert.equal((await t.agents.resolve("s1", "reviewer")).c.id, fork.id);
  } finally {
    await t.cleanup();
  }
});
