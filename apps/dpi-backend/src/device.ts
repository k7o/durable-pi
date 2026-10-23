// The device: one machine's sessions, agents, documents and jobs. This is the composition root —
// it opens the device's modules and holds the few use cases that span them. Every other method is a
// delegation or a documented join; see docs/agents/store-split.md.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, ConversationRecord, Harness, ModelRef } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { join, resolve } from "node:path";
import {
  THINKING_LEVELS,
  type AgentDetail,
  type AgentExtensions,
  type AgentSummary,
  type CompactionSettings,
  type CreateSessionBody,
  type DeviceInfo,
  type DeviceTree,
  type DirListing,
  type InboxItem,
  type Page,
  type SendResult,
  type SessionSummary,
  type TaskNode,
  type TaskOutcome,
  type ThinkingLevel,
  type UsageTotals,
  type WireEntry,
} from "../../dpi-sdk/src/api.js";
import { lastAssistantText } from "../../dpi-sdk/src/transcript.js";
import { ADDON_INFO, PROMPTS, PromptChecklist } from "./addons.js";
import { Agents, type Resolved } from "./agents.js";
import { Catalog, type SessionRow } from "./catalog.js";
import { ChangeFeed } from "./changes.js";
import { Compaction } from "./compaction.js";
import { Conversations } from "./conversations.js";
import { Documents } from "./documents.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import { type SpawnSession } from "./extensions.js";
import { JOB_DEFS } from "./jobs.js";
import { lockFile } from "./locks.js";
import { Models } from "./models.js";
import { Playground } from "./playground.js";
import type { ProviderId } from "./provider.js";
import { SessionRuntime } from "./session-runtime.js";
import { SharedState } from "./shared-state.js";

export { AGENT_DOC_KINDS, DEVICE_DOC_KINDS } from "./documents.js";
export type { Resolved, SessionRow };

export const DURABLE_VERSION = "1.0.3";

export interface DeviceOptions {
  dataDir: string;
  startDirs: string[];
  name: string;
  provider: ProviderId;
  /** Overrides the provider's default model. */
  defaultModel?: string;
}

/** apps/dpi-backend/src → the checkout root. */
const CODE_DIR = resolve(import.meta.dirname, "../../..");

export class Device {
  readonly startedAt = Date.now();
  readonly uid: string;
  readonly conversations = new Conversations();
  shared!: SharedState;
  documents!: Documents;
  sessions!: SessionRuntime;
  agentView!: Agents;
  playground!: Playground;
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
    readonly options: DeviceOptions,
    readonly catalog: Catalog,
    readonly changes: ChangeFeed,
    readonly models: Models,
    readonly compaction: Compaction,
  ) {
    this.uid = catalog.deviceUid;
  }

  static async open(options: DeviceOptions) {
    const resolved = { ...options, dataDir: resolve(options.dataDir) };
    const changes = new ChangeFeed();
    const catalog = await Catalog.open(resolved.dataDir, changes);
    const models = await Models.open(resolved.provider, resolved.defaultModel);
    const compaction = new Compaction(catalog, models);
    const device = new Device(resolved, catalog, changes, models, compaction);
    try {
      device.unlockShared = lockFile(`${device.sharedStatePath}.lock`);
      device.shared = await SharedState.open(device.sharedStatePath);
      device.documents = new Documents(device.shared);
      device.playground = new Playground(device.shared, device.documents);
      device.sessions = new SessionRuntime({
        catalog,
        models,
        compaction,
        changes,
        shared: device.shared,
        spawn: device.spawnSession,
        archiveDir: device.archiveDir,
        startDirs: device.startDirs,
        name: device.name,
        offline: resolved.provider === "faux",
      });
      device.agentView = new Agents({
        catalog,
        models,
        compaction,
        changes,
        sessions: device.sessions,
        conversations: device.conversations,
      });
      device.shared.harness.subscribeCommits(() => device.notify());
      await device.sessions.prepare();
      await device.sessions.openAll(device.list());
      if (!(await device.shared.initialized()))
        await device.shared.initialize({ goal: "Explore durable agents", counter: 0, notes: [] });
      for (const { harness } of device.sessions.opened.values()) harness.resume();
      return device;
    } catch (e) {
      await device.close().catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------ change feed

  subscribe = (fn: () => void) => this.changes.subscribe(fn);
  notify = () => this.changes.notify();

  // ------------------------------------------------------------ device

  deviceInfo = (): DeviceInfo => ({
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
  });

  routedModel = (model?: ModelRef): ModelRef => this.models.routed(model);
  validateModel = (model: unknown): ModelRef => this.models.validate(model);

  // ------------------------------------------------------------ directories

  directories = (): Promise<DirListing> => this.sessions.directories();
  browse = (path: string): Promise<DirListing> => (path ? this.sessions.browse(path) : this.directories());

  // ------------------------------------------------------------ sessions

  list = () => this.catalog.listSessions();

  row = (id: string) => {
    const row = this.catalog.getSession(id);
    if (!row) throw notFound(`No session ${id}`);
    return row;
  };

  /** A session by UUID or unique case-insensitive name. */
  resolveSession = (ref: string): SessionRow => {
    try {
      return this.catalog.resolveSession(ref);
    } catch (e) {
      if (e instanceof ApiFault && e.code === "not_found") throw notFound(`No session "${ref}" on ${this.name}`);
      throw e;
    }
  };

  harness = (row: SessionRow) => this.sessions.harness(row);
  isOpen = (sessionId: string) => this.sessions.isOpen(sessionId);

  /** `spawnKey` records which tool call created the session, in the same transaction as the session row. */
  async create(body: CreateSessionBody, spawnKey?: string): Promise<SessionSummary> {
    if (typeof body?.name !== "string") throw invalid("name is required");
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw invalid("cwd is required");
    const cwd = await this.sessions.resolveCwd(body.cwd.trim());
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
    await this.sessions.open(row, true, body.thinkingLevel ?? "low");
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
    const { c } = await this.agentView.resolve(session.id, "main");
    const submission = await this.conversations.send(c, { content: input.prompt, requestId: `${input.key}:prompt` });
    return { session, submissionId: submission.id as number };
  };

  rename(row: SessionRow, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    this.catalog.renameSession(row.id, name.trim().slice(0, 100));
    return this.sessionSummary(this.row(row.id));
  }

  archive = (row: SessionRow) => this.sessions.archive(row);
  openAgent = (row: SessionRow, create = false, thinkingLevel: ThinkingLevel = "low") =>
    this.sessions.open(row, create, thinkingLevel);
  scanAll = (h: Harness): Promise<ConversationRecord[]> => this.sessions.scanAll(h);

  // ------------------------------------------------------------ agents

  agents = (row: SessionRow, tasks?: TaskNode[]): Promise<AgentSummary[]> => this.agentView.list(row, tasks);
  liveTasks = (h: Harness): Promise<TaskNode[]> => this.conversations.liveTasks(h);
  taskNode = (t: unknown): TaskNode => this.conversations.taskNode(t);
  resolveAgent = (sessionRef: string, agentRef: string): Promise<Resolved> =>
    this.agentView.resolve(sessionRef, agentRef);
  agentSummary = (row: SessionRow, c: Conversation): Promise<AgentSummary> => this.agentView.summary(row, c);
  agentDetail = (row: SessionRow, c: Conversation): Promise<AgentDetail> => this.agentView.detail(row, c);
  setAgentName = (row: SessionRow, agentId: number, name: unknown) => this.agentView.setName(row, agentId, name);
  createAgent = (row: SessionRow, body: { from?: unknown; name?: unknown }) => this.agentView.create(row, body);
  fork = (row: SessionRow, c: Conversation, body: { entryId?: unknown; name?: unknown }) =>
    this.agentView.fork(row, c, body);
  configure = (row: SessionRow, c: Conversation, body: Record<string, unknown>) =>
    this.agentView.configure(row, c, body);

  // ------------------------------------------------------------ conversations

  send = (c: Conversation, body: Record<string, unknown>) => this.conversations.send(c, body);
  settled = (h: Harness, submissionId: number, waitMs = 0, signal?: AbortSignal): Promise<SendResult> =>
    this.conversations.settled(h, submissionId, waitMs, signal);
  abort = (c: Conversation, background: boolean) => this.conversations.abort(c, background);
  withdraw = (h: Harness, c: Conversation, submissionId: number) =>
    this.conversations.withdraw(h, c, submissionId);
  compact = (c: Conversation, instructions?: unknown) => this.conversations.compact(c, instructions);
  reset = (c: Conversation, note?: unknown) => this.conversations.reset(c, note);
  tasks = (h: Harness, status: string, limit: number): Promise<TaskOutcome[]> =>
    this.conversations.tasks(h, status, limit);
  abortTask = (h: Harness, taskId: number) => this.conversations.abortTask(h, taskId);
  inspect = (h: Harness) => this.conversations.inspect(h);
  entries = (c: Conversation, cursor: string | undefined, limit: number): Promise<Page<WireEntry>> =>
    this.conversations.entries(c, cursor, limit);
  activeEntries = (c: Conversation): Promise<WireEntry[]> => this.conversations.activeEntries(c);
  transcript = (c: Conversation, format: string) => this.conversations.transcript(c, format);
  inbox = (h: Harness, c: Conversation): Promise<InboxItem[]> =>
    this.conversations.inbox(h, c);
  usage = (h: Harness): Promise<UsageTotals> => this.conversations.usage(h);
  labelTasks = (h: Harness, nodes: TaskNode[]) =>
    this.conversations.labelTasks(h, nodes);

  /** Joins a session row to its open conversation and returns the last assistant reply. */
  async preview(row: SessionRow, agentId: number) {
    const h = this.sessions.isOpen(row.id) ? this.sessions.harness(row) : undefined;
    const c = h ? await h.conversation(agentId as ConversationId, ctx) : undefined;
    if (!c) return undefined;
    return lastAssistantText(await this.conversations.activeEntries(c))?.slice(0, 200);
  }

  // ------------------------------------------------------------ documents

  agentDoc = (h: Harness, c: Conversation, kind: string) =>
    this.documents.agentDoc(h, c, kind);
  deviceDoc = (kind: string) => this.documents.deviceDoc(kind);

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

  // ------------------------------------------------------------ compaction (per session)

  compactionOf = (sessionId: string): CompactionSettings => this.compaction.get(sessionId);
  setCompaction = (row: SessionRow, body: Record<string, unknown>): CompactionSettings => this.compaction.set(row, body);

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

  // ------------------------------------------------------------ playground

  demoState = (c: Conversation, body: Record<string, unknown>) => this.playground.demoState(c, body);

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  startJob(row: SessionRow, h: Harness, c: Conversation, body: Record<string, unknown>) {
    if (!this.sessions.isOpen(row.id)) throw new ApiFault("unavailable", "Session is not open");
    return this.playground.startJob(row, h, c, this.sessions.jobs(row), body);
  }

  approveJob = (c: Conversation, taskId: number, approved: unknown) => this.playground.approveJob(c, taskId, approved);

  // ------------------------------------------------------------ idempotency

  replay = (key: string, route: string) => this.catalog.replay(key, route);
  remember = (key: string, route: string, status: number, body: unknown) => this.catalog.remember(key, route, status, body);

  // ------------------------------------------------------------ lifecycle

  async close() {
    await this.sessions?.close();
    await this.shared?.close();
    this.unlockShared?.();
    await this.catalog.close();
  }
}
