import { SharedState } from "./shared-state.js";
import type { StateChange } from "../../dpi-sdk/src/app-state.js";
import type {
  AgentDetail,
  AgentExtensions,
  AgentSummary,
  CreateSessionBody,
  DeviceInfo,
  DeviceTree,
  DirListing,
  InboxItem,
  Page,
  SendResult,
  SessionSummary,
  TaskNode,
  TaskOutcome,
  ThinkingLevel,
  UsageTotals,
  WireEntry,
} from "../../dpi-sdk/src/api.js";
import {
  THINKING_LEVELS,
  type CompactionSettings,
} from "../../dpi-sdk/src/api.js";
import { lastAssistantText } from "../../dpi-sdk/src/transcript.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import { lockFile } from "./locks.js";
import { ChangeFeed } from "./changes.js";
import { Catalog, type SessionRow } from "./catalog.js";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Models } from "./models.js";
import { Compaction } from "./compaction.js";
import { type ProviderId } from "./provider.js";
import {
  Harness,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { type SpawnSession } from "./extensions.js";
import type { Resolved } from "./agents.js";
import { JobRuns, JOB_DEFS, jobDef, resolveJobInput } from "./jobs.js";
import { ADDON_INFO, PROMPTS, PromptChecklist } from "./addons.js";
import { Documents } from "./documents.js";
import { SessionRuntime } from "./session-runtime.js";
import { Conversations } from "./conversations.js";
import { Agents } from "./agents.js";
export type { Resolved } from "./agents.js";
export { AGENT_DOC_KINDS, DEVICE_DOC_KINDS } from "./documents.js";

export const DURABLE_VERSION = "1.0.3";

export type { SessionRow };

export interface StoreOptions {
  dataDir: string;
  startDirs: string[];
  name: string;
  provider: ProviderId;
  /** Overrides the provider's default model. */
  defaultModel?: string;
}

/** Agent documents a client may read or stream, by kind. */
/** apps/dpi-backend/src → the checkout root. */
const CODE_DIR = resolve(import.meta.dirname, "../../..");


export class Store {
  readonly startedAt = Date.now();
  readonly uid: string;
  shared!: SharedState;
  documents!: Documents;
  sessions!: SessionRuntime;
  agentView!: Agents;
  readonly conversations = new Conversations();
  private unlockShared?: () => void;

  get catalogPath() {
    return join(this.options.dataDir, "catalog.sqlite");
  }
  get sharedStatePath() {
    return join(this.options.dataDir, "app-state.sqlite");
  }
  get sessionsDir() {
    return join(this.options.dataDir, "sessions");
  }
  get archiveDir() {
    return join(this.options.dataDir, "archive");
  }
  get name() {
    return this.options.name;
  }
  get startDirs() {
    return this.options.startDirs;
  }

  private constructor(
    readonly options: StoreOptions,
    readonly catalog: Catalog,
    readonly changes: ChangeFeed,
    readonly models: Models,
    readonly compaction: Compaction,
  ) {
    this.uid = catalog.deviceUid;
  }

  static async open(options: StoreOptions) {
    const resolved = { ...options, dataDir: resolve(options.dataDir) };
    // Start dirs are where new sessions begin; create any that do not exist yet.
    await Promise.all(resolved.startDirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => {})));
    const changes = new ChangeFeed();
    const catalog = await Catalog.open(resolved.dataDir, changes);
    const models = await Models.open(resolved.provider, resolved.defaultModel);
    const compaction = new Compaction(catalog, models);
    const store = new Store(resolved, catalog, changes, models, compaction);
    try {
      store.unlockShared = lockFile(`${store.sharedStatePath}.lock`);
      store.shared = await SharedState.open(store.sharedStatePath);
      store.documents = new Documents(store.shared);
      store.sessions = new SessionRuntime({
        catalog,
        models,
        compaction,
        changes,
        shared: store.shared,
        spawn: store.spawnSession,
        archiveDir: store.archiveDir,
        startDirs: store.startDirs,
        name: store.name,
        offline: resolved.provider === "faux",
      });
      store.shared.harness.subscribeCommits(() => store.notify());
      store.agentView = new Agents({
        catalog,
        models,
        compaction,
        changes,
        sessions: store.sessions,
        conversations: store.conversations,
      });
      await store.sessions.openAll(store.list());
      if (!(await store.shared.initialized()))
        await store.shared.initialize({ goal: "Explore durable agents", counter: 0, notes: [] });
      for (const { harness } of store.sessions.opened.values()) harness.resume();
      return store;
    } catch (e) {
      await store.close().catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------ change feed

  subscribe(fn: () => void) {
    return this.changes.subscribe(fn);
  }
  notify = () => this.changes.notify();

  // ------------------------------------------------------------ device

  deviceInfo(): DeviceInfo {
    return {
      uid: this.uid,
      name: this.name,
      hostname: hostname(),
      platform: `${platform()}-${process.arch} node ${process.version}`,
      apiVersion: 1,
      durableVersion: DURABLE_VERSION,
      startedAt: this.startedAt,
      startDirs: this.startDirs,
      models: this.models.list,
      defaultModel: this.models.defaultModelId,
      storage: { dataDir: this.options.dataDir, catalogPath: this.catalogPath, appStatePath: this.sharedStatePath },
      codeDir: CODE_DIR,
      capabilities: ["events", "docs", "demo", "jobs"],
      jobs: JOB_DEFS,
    };
  }

  routedModel(model?: ModelRef): ModelRef {
    return this.models.routed(model);
  }

  validateModel(model: unknown): ModelRef {
    return this.models.validate(model);
  }

  // ------------------------------------------------------------ directories

  async directories(): Promise<DirListing> {
    return this.sessions.directories();
  }

  async browse(path: string): Promise<DirListing> {
    if (!path) return this.directories();
    return this.sessions.browse(path);
  }

  // ------------------------------------------------------------ sessions

  list(): SessionRow[] {
    return this.catalog.listSessions();
  }

  row(id: string): SessionRow {
    const row = this.catalog.getSession(id);
    if (!row) throw notFound(`No session ${id}`);
    return row;
  }

  /** A session by UUID or unique case-insensitive name. */
  resolveSession(ref: string): SessionRow {
    try {
      return this.catalog.resolveSession(ref);
    } catch (e) {
      if (e instanceof ApiFault && e.code === "not_found") throw notFound(`No session "${ref}" on ${this.name}`);
      throw e;
    }
  }

  harness(row: SessionRow) {
    return this.sessions.harness(row);
  }

  isOpen(sessionId: string) {
    return this.sessions.isOpen(sessionId);
  }

  /** `spawnKey` records which tool call created the session, in the same transaction as the session row. */
  async create(body: CreateSessionBody, spawnKey?: string): Promise<SessionSummary> {
    if (typeof body?.name !== "string") throw invalid("name is required");
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw invalid("cwd is required");
    const path = body.cwd.trim();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let cwd: string;
    try {
      cwd = await realpath(resolve(this.startDirs[0] ?? homedir(), expanded));
      if (!(await stat(cwd)).isDirectory()) throw Error();
    } catch {
      throw invalid(`cwd must be an existing folder on ${this.name}`);
    }
    const model = this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel))
      throw invalid("Invalid thinking level");
    const id = randomUUID();
    const row: SessionRow = {
      id,
      name: body.name.trim().slice(0, 100) || "Untitled session",
      cwd,
      dbPath: join(this.sessionsDir, id, "agent.sqlite"),
      createdAt: Date.now(),
      model: model.modelId,
      provider: model.provider,
    };
    await this.openAgent(row, true, body.thinkingLevel ?? "low");
    this.catalog.insertSession(row, spawnKey);
    return this.sessionSummary(row);
  }

  /**
   * The start_session tool. A replay of the same tool call (same `key`) finds the session it created, and the first
   * prompt reuses its requestId, so a crash never starts a second session or sends the prompt twice.
   */
  spawnSession: SpawnSession = async (input) => {
    const found = this.catalog.spawnOwner(input.key);
    const existing = found && this.list().find((r) => r.id === found);
    const session = existing
      ? await this.sessionSummary(existing)
      : await this.create(
          { name: input.name, cwd: input.cwd, model: input.model, thinkingLevel: input.thinkingLevel },
          input.key,
        );
    if (!input.prompt) return { session };
    const { c } = await this.resolveAgent(session.id, "main");
    const submission = await this.send(c, { content: input.prompt, requestId: `${input.key}:prompt` });
    return { session, submissionId: submission.id as number };
  };

  rename(row: SessionRow, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    this.catalog.renameSession(row.id, name.trim().slice(0, 100));
    return this.sessionSummary(this.row(row.id));
  }

  /** Stop all work, close the harness and move its files to archive/. Nothing is deleted. */
  async archive(row: SessionRow) {
    return this.sessions.archive(row);
  }

  async openAgent(row: SessionRow, create = false, thinkingLevel: ThinkingLevel = "low") {
    return this.sessions.open(row, create, thinkingLevel);
  }

  async scanAll(h: Harness): Promise<ConversationRecord[]> {
    return this.sessions.scanAll(h);
  }

  // ------------------------------------------------------------ agents

  async agents(row: SessionRow, tasks?: TaskNode[]): Promise<AgentSummary[]> {
    return this.agentView.list(row, tasks);
  }

  async liveTasks(h: Harness): Promise<TaskNode[]> {
    return this.conversations.liveTasks(h);
  }

  taskNode(t: unknown): TaskNode {
    return this.conversations.taskNode(t);
  }

  async resolveAgent(sessionRef: string, agentRef: string): Promise<Resolved> {
    return this.agentView.resolve(sessionRef, agentRef);
  }

  async agentSummary(row: SessionRow, c: Conversation): Promise<AgentSummary> {
    return this.agentView.summary(row, c);
  }

  async agentDetail(row: SessionRow, c: Conversation): Promise<AgentDetail> {
    return this.agentView.detail(row, c);
  }

  setAgentName(row: SessionRow, agentId: number, name: unknown) {
    return this.agentView.setName(row, agentId, name);
  }

  async createAgent(row: SessionRow, body: { from?: unknown; name?: unknown }) {
    return this.agentView.create(row, body);
  }

  async fork(row: SessionRow, c: Conversation, body: { entryId?: unknown; name?: unknown }) {
    return this.agentView.fork(row, c, body);
  }

  async configure(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    return this.agentView.configure(row, c, body);
  }

  async send(c: Conversation, body: Record<string, unknown>) {
    return this.conversations.send(c, body);
  }

  async settled(h: Harness, submissionId: number, waitMs = 0, signal?: AbortSignal): Promise<SendResult> {
    return this.conversations.settled(h, submissionId, waitMs, signal);
  }

  async abort(c: Conversation, background: boolean) {
    return this.conversations.abort(c, background);
  }

  async withdraw(h: Harness, c: Conversation, submissionId: number) {
    return this.conversations.withdraw(h, c, submissionId);
  }

  async compact(c: Conversation, instructions?: unknown) {
    return this.conversations.compact(c, instructions);
  }

  async reset(c: Conversation, note?: unknown) {
    return this.conversations.reset(c, note);
  }

  async tasks(h: Harness, status: string, limit: number): Promise<TaskOutcome[]> {
    return this.conversations.tasks(h, status, limit);
  }

  async abortTask(h: Harness, taskId: number) {
    return this.conversations.abortTask(h, taskId);
  }

  async inspect(h: Harness) {
    return this.conversations.inspect(h);
  }

  async entries(c: Conversation, cursor: string | undefined, limit: number): Promise<Page<WireEntry>> {
    return this.conversations.entries(c, cursor, limit);
  }

  async activeEntries(c: Conversation): Promise<WireEntry[]> {
    return this.conversations.activeEntries(c);
  }

  async transcript(c: Conversation, format: string) {
    return this.conversations.transcript(c, format);
  }

  async preview(row: SessionRow, agentId: number) {
    const h = this.sessions.isOpen(row.id) ? this.sessions.harness(row) : undefined;
    const c = h ? await h.conversation(agentId as ConversationId, ctx) : undefined;
    if (!c) return undefined;
    return lastAssistantText(await this.conversations.activeEntries(c))?.slice(0, 200);
  }

  async inbox(h: Harness, c: Conversation): Promise<InboxItem[]> {
    return this.conversations.inbox(h, c);
  }

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    return this.documents.agentDoc(h, c, kind);
  }

  async deviceDoc(kind: string) {
    return this.documents.deviceDoc(kind);
  }

  async usage(h: Harness): Promise<UsageTotals> {
    return this.conversations.usage(h);
  }

  // ------------------------------------------------------------ custom extensions (per agent)

  async extensionsOf(row: SessionRow, c: Conversation): Promise<AgentExtensions> {
    const active = new Set((await c.agent(ctx)).extensions.map((e) => e.name));
    const checked = (await this.harness(row).snapshot(PromptChecklist, c.id, ctx))?.enabled ?? [PROMPTS[0].id];
    return {
      builtIn: [...active].filter((name) => !ADDON_INFO.some((a) => a.name === name)),
      extensions: ADDON_INFO.map((info) => ({
        ...info,
        enabled: active.has(info.name),
        ...(info.name === "system-prompts"
          ? { prompts: PROMPTS.map(({ id, title, description, text }) => ({ id, title, description, text, enabled: checked.includes(id) })) }
          : {}),
      })),
    };
  }

  /** `{name, enabled}` edits the agent's extension selection; `{prompt, enabled}` edits its prompt checklist. */
  async setExtension(row: SessionRow, c: Conversation, body: Record<string, unknown>) {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const enabled = body.enabled;
    if (typeof body.name === "string") {
      const extension = this.sessions.addons(row).all[body.name];
      if (!extension) throw invalid(`Unknown extension ${body.name}. Known: ${ADDON_INFO.map((a) => a.name).join(", ")}`);
      // An array is the agent's whole selection. An { add | remove } object would edit the host default instead and
      // replace the previous edit, so turning one extension on would turn the other off.
      const rank = (name: string) => ADDON_INFO.findIndex((a) => a.name === name);
      const others = (await c.agent(ctx)).extensions.filter((e) => e.name !== extension.name);
      const next = (enabled ? [...others, extension] : others).sort((a, b) => rank(a.name) - rank(b.name));
      await c.configure({ extensions: next }, ctx);
    } else if (typeof body.prompt === "string") {
      const prompt = body.prompt;
      if (!PROMPTS.some((p) => p.id === prompt)) throw invalid(`Unknown prompt ${prompt}. Known: ${PROMPTS.map((p) => p.id).join(", ")}`);
      await c.commit(async (tx) => {
        const doc = await tx.doc(PromptChecklist, c.id);
        const next = new Set(doc.enabled);
        if (enabled) next.add(prompt);
        else next.delete(prompt);
        doc.enabled = PROMPTS.map((p) => p.id).filter((id) => next.has(id));
      }, ctx);
    } else throw invalid("name or prompt is required");
    this.notify();
    return this.extensionsOf(row, c);
  }

  // ------------------------------------------------------------ compaction settings (per session)

  /** Saved thresholds, or the defaults for the session model's window (200k background, 250k wait when it fits). */
  compactionOf(sessionId: string): CompactionSettings {
    return this.compaction.get(sessionId);
  }

  /** Validate and store new thresholds; pi-durable reads them at its next use, so they apply from the next request. */
  setCompaction(row: SessionRow, body: Record<string, unknown>): CompactionSettings {
    return this.compaction.set(row, body);
  }

  /** Name every pi.tool task by its tool and every job run by its title, so a task list reads like the transcript. */
  async labelTasks(h: Harness, nodes: TaskNode[]): Promise<TaskNode[]> {
    return this.conversations.labelTasks(h, nodes);
  }

  // ------------------------------------------------------------ tree

  sessionSummaryBase(row: SessionRow) {
    return {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: row.model,
      createdAt: row.createdAt,
      dbPath: row.dbPath,
      compaction: this.compactionOf(row.id),
    };
  }

  async sessionSummary(row: SessionRow): Promise<SessionSummary> {
    if (!this.sessions.isOpen(row.id))
      return {
        ...this.sessionSummaryBase(row),
        busy: false,
        agents: [],
        error: this.sessions.errors.get(row.id) ?? "Session unavailable",
      };
    const agents = await this.agents(row);
    return { ...this.sessionSummaryBase(row), busy: agents.some((a) => a.busy), agents };
  }

  async tree(): Promise<DeviceTree> {
    const sessions = await Promise.all(this.list().map((row) => this.sessionSummary(row)));
    return { uid: this.uid, name: this.name, sessions, at: Date.now() };
  }

  // ------------------------------------------------------------ demo extension

  async demoState(c: Conversation, body: Record<string, unknown>) {
    let change = body as unknown as StateChange;
    if (body.operation === undefined) {
      const { value } = await this.shared.snapshot();
      if (typeof body.goal === "string")
        change = { operation: Object.hasOwn(value, "goal") ? "update" : "create", path: "/goal", value: body.goal };
      else if (body.increment === true) change = { operation: "increment", path: "/counter", value: 1 };
      else if (typeof body.note === "string") change = { operation: "create", path: "/notes/-", value: body.note };
      else throw invalid("A state operation is required");
    }
    await this.shared.change(
      change,
      undefined,
      typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
    );
    await c.commit(
      (tx) =>
        tx.appendEntry(c.id, {
          kind: "demo.state-change",
          data: { text: `Shared App State: ${change.operation} ${change.path || "/"}` },
        }),
      ctx,
    );
    return { ok: true as const, ...(await this.deviceDoc("app.shared-state")) };
  }

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  async startJob(row: SessionRow, h: Harness, c: Conversation, body: Record<string, unknown>) {
    const def = typeof body.job === "string" ? jobDef(body.job) : undefined;
    if (!def) throw invalid(`job must be one of ${JOB_DEFS.map((d) => d.id).join(", ")}`);
    let input;
    try {
      input = resolveJobInput(def, body.input ?? {});
    } catch (e) {
      throw invalid((e as Error).message);
    }
    if (!this.sessions.isOpen(row.id)) throw new ApiFault("unavailable", "Session is not open");
    const jobs = this.sessions.jobs(row);
    const taskId = await c.commit(async (tx) => {
      const id = await jobs.start(tx, c.id, { def, input, startedBy: "you", now: Date.now() });
      await tx.appendEntry(c.id, { kind: "demo.job", data: { taskId: id as number, job: def.id, text: `Started ${def.title}` } });
      return id;
    }, ctx);
    h.resume();
    return { taskId: taskId as number };
  }

  async approveJob(c: Conversation, taskId: number, approved: unknown) {
    if (typeof approved !== "boolean") throw invalid("approved must be a boolean");
    await c.commit(async (tx) => {
      const run = (await tx.doc(JobRuns, c.id)).items[String(taskId)];
      if (!run || run.approval !== "pending") throw new ApiFault("conflict", "No pending approval for that run");
      run.approval = approved ? "approved" : "declined";
    }, ctx);
    return { ok: true as const };
  }

  // ------------------------------------------------------------ idempotency

  replay(key: string, route: string) {
    return this.catalog.replay(key, route);
  }

  remember(key: string, route: string, status: number, body: unknown) {
    this.catalog.remember(key, route, status, body);
  }

  // ------------------------------------------------------------ lifecycle

  async close() {
    await this.sessions?.close();
    await this.shared?.close();
    this.unlockShared?.();
    await this.catalog.close();
  }
}

