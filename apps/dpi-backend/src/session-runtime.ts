// A session's runtime: its database, lock, harness, jobs, addons and selected extensions. One
// instance owns every open session on the device; archiving stops work and moves the files aside.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { mkdir, readdir, realpath, rename as renamePath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SessionSummary, ThinkingLevel } from "../../dpi-sdk/src/api.js";
import { createAddons, type Addons } from "./addons.js";
import type { Catalog, SessionRow } from "./catalog.js";
import type { ChangeFeed } from "./changes.js";
import type { Compaction } from "./compaction.js";
import { ApiFault, notFound } from "./errors.js";
import { createPlayground, Workspace, type SpawnSession } from "./extensions.js";
import { createJobs, JobRuns, type Jobs } from "./jobs.js";
import { lockFile } from "./locks.js";
import type { Models } from "./models.js";
import type { SharedState } from "./shared-state.js";
import { Todos } from "./todos.js";
import { CODING_WRITES, withWrites } from "./tool-policy.js";

type Opened = { harness: Harness; unlock: () => void; unsubscribe: () => void; jobs: Jobs; addons: Addons };

export interface SessionRuntimeOptions {
  catalog: Catalog;
  models: Models;
  compaction: Compaction;
  changes: ChangeFeed;
  shared: SharedState;
  spawn: SpawnSession;
  archiveDir: string;
  startDirs: string[];
  /** The device name, used in error messages. */
  name: string;
  offline: boolean;
}

export class SessionRuntime {
  readonly opened = new Map<string, Opened>();
  readonly errors = new Map<string, string>();

  constructor(private readonly options: SessionRuntimeOptions) {}

  isOpen(sessionId: string): boolean {
    return this.opened.has(sessionId);
  }

  harness(row: SessionRow): Harness {
    const opened = this.opened.get(row.id);
    if (!opened) throw this.unavailable(row);
    return opened.harness;
  }

  jobs(row: SessionRow): Jobs {
    const opened = this.opened.get(row.id);
    if (!opened) throw this.unavailable(row);
    return opened.jobs;
  }

  addons(row: SessionRow): Addons {
    const opened = this.opened.get(row.id);
    if (!opened) throw this.unavailable(row);
    return opened.addons;
  }

  private unavailable(row: SessionRow) {
    const reason = this.errors.get(row.id);
    return new ApiFault(
      "unavailable",
      reason ? `Session ${row.name} is unavailable: ${reason}` : `Session ${row.name} is unavailable`,
    );
  }

  /** Open every session the catalog knows about, recording the ones that cannot open. */
  async openAll(rows: readonly SessionRow[], options: { create?: boolean; thinkingLevel?: ThinkingLevel } = {}) {
    for (const row of rows) {
      try {
        await this.open(row, options.create ?? false, options.thinkingLevel);
      } catch (e) {
        this.errors.set(row.id, String(e instanceof Error ? e.message : e));
      }
    }
  }

  async open(row: SessionRow, create = false, thinkingLevel: ThinkingLevel = "low"): Promise<Harness> {
    const current = this.opened.get(row.id);
    if (current) return current.harness;
    if (!create) await stat(row.dbPath);
    await mkdir(dirname(row.dbPath), { recursive: true });
    const unlock = lockFile(`${row.dbPath}.lock`);
    try {
      const shellEnv = Object.fromEntries(
        ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"].flatMap((k) =>
          process.env[k] ? [[k, process.env[k]]] : [],
        ),
      );
      const registry = createRegistry();
      const coding = withWrites(CodingTools, CODING_WRITES);
      registry.install(coding);
      const jobs = createJobs({ shared: this.options.shared, sessionId: row.id });
      const thresholds = () => this.options.compaction.get(row.id);
      const playground = createPlayground(this.options.shared, row.id, this.options.spawn, jobs);
      registry.install(playground);
      // Custom extensions are installed but not selected: an agent turns them on in its own selection.
      const addons = createAddons({ offline: this.options.offline });
      for (const extension of addons.list) registry.install(extension);
      const harness = await Harness.open(
        await openNodeSqliteStorage(row.dbPath),
        {
          models: this.options.models.engine,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? row.cwd, shellEnv }),
          conversationCreated: async (tx, c) => {
            await tx.doc(Workspace, c.id);
            await tx.doc(JobRuns, c.id);
            await tx.doc(Todos, c.id);
          },
          settings: {
            extensions: [coding, playground],
            // Read at every use, so a PATCH .../compaction applies from the next request.
            get compaction() {
              return thresholds();
            },
            progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
          },
          onReport: (e) => console.error("[durable]", String(e)),
        },
        ctx,
      );
      await harness.root(ctx, {
        agent: {
          cwd: row.cwd,
          model: { provider: row.provider, modelId: row.model },
          thinkingLevel,
        },
      });
      // Route stored agent choices to this device's provider before recovery issues any request.
      for (const record of await this.scanAll(harness)) {
        const conversation = (await harness.conversation(record.id, ctx))!;
        const previous = (await conversation.agent(ctx)).model;
        const routed = this.options.models.routed(previous);
        if (previous?.provider !== routed.provider || previous.modelId !== routed.modelId)
          await conversation.configure({ model: routed }, ctx);
      }
      const rootModel = (await (await harness.root(ctx)).agent(ctx)).model!;
      row.provider = rootModel.provider;
      row.model = rootModel.modelId;
      this.options.catalog.setSessionModel(row.id, { provider: row.provider, modelId: row.model });
      const unsubscribe = harness.subscribeCommits(() => this.options.changes.notify());
      this.opened.set(row.id, { harness, unlock, unsubscribe, jobs, addons });
      this.errors.delete(row.id);
      if (create) harness.resume();
      return harness;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  async scanAll(h: Harness) {
    return h.commit(async (tx) => {
      let page = await tx.scanConversations({}, 1000);
      const records = [...page.items];
      while (page.next) {
        page = await tx.scanConversations({}, 1000, page.next);
        records.push(...page.items);
      }
      return records;
    }, ctx);
  }

  /** Stop all work, close the harness and move its files to archive/. Nothing is deleted. */
  async archive(row: SessionRow): Promise<{ archived: string }> {
    const opened = this.opened.get(row.id);
    if (opened) {
      for (const record of await this.scanAll(opened.harness)) {
        const c = await opened.harness.conversation(record.id, ctx);
        if (c) await c.abort(ctx, { background: true }).catch(() => {});
      }
      opened.unsubscribe();
      try {
        await opened.harness.close(ctx);
      } finally {
        opened.unlock();
      }
      this.opened.delete(row.id);
    }
    await mkdir(this.options.archiveDir, { recursive: true });
    const target = join(this.options.archiveDir, `${row.id}-${Date.now()}`);
    try {
      await renamePath(dirname(row.dbPath), target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.options.catalog.forgetSession(row.id);
    this.options.compaction.forget(row.id);
    this.errors.delete(row.id);
    return { archived: target };
  }

  // ------------------------------------------------------------ directories

  async directories() {
    const dirs: { name: string; path: string }[] = [];
    for (const root of this.options.startDirs) {
      try {
        dirs.push({ name: root, path: await realpath(root) });
      } catch {}
    }
    return { path: "", dirs };
  }

  async browse(path: string) {
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let real: string;
    try {
      real = await realpath(resolve(expanded));
      if (!(await stat(real)).isDirectory()) throw Error();
    } catch {
      throw notFound(`Not a directory on ${this.options.name}: ${path}`);
    }
    const dirs: { name: string; path: string }[] = [];
    try {
      for (const entry of await readdir(real, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        dirs.push({ name: entry.name, path: join(real, entry.name) });
      }
    } catch (e) {
      throw new ApiFault("unavailable", `Cannot list ${real}: ${(e as Error).message}`);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, parent: dirname(real) !== real ? dirname(real) : undefined, dirs: dirs.slice(0, 500) };
  }

  async close() {
    for (const { harness, unlock, unsubscribe } of this.opened.values()) {
      unsubscribe();
      try {
        await harness.close(ctx);
      } finally {
        unlock();
      }
    }
    this.opened.clear();
  }
}

export type { Opened };
