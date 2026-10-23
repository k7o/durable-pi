// The agents inside one open session: resolve a name, project a summary or detail, and change an
// agent's name, tools, model or fork point. A session row and a conversation are passed in.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  ConversationRecord,
  EntryId,
  Harness,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  THINKING_LEVELS,
  type AgentConfig,
  type AgentDetail,
  type AgentRef,
  type AgentSummary,
  type TaskNode,
  type ThinkingLevel,
} from "../../dpi-sdk/src/api.js";
import type { Catalog, SessionRow } from "./catalog.js";
import type { ChangeFeed } from "./changes.js";
import type { Compaction } from "./compaction.js";
import type { Conversations } from "./conversations.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import type { Models } from "./models.js";
import type { SessionRuntime } from "./session-runtime.js";
import { writes } from "./tool-policy.js";

export type Resolved = { row: SessionRow; h: Harness; c: Conversation };

export interface AgentsOptions {
  catalog: Catalog;
  models: Models;
  compaction: Compaction;
  changes: ChangeFeed;
  sessions: SessionRuntime;
  conversations: Conversations;
}

export class Agents {
  constructor(private readonly options: AgentsOptions) {}

  private agentRef(record: ConversationRecord, names: Map<number, string>): AgentRef {
    const id = record.id as number;
    const kind = record.parent ? "fork" : record.owner ? "subagent" : "root";
    const custom = names.get(id);
    const derived =
      id === 1 ? "Main" : kind === "fork" ? `Fork #${id}` : kind === "subagent" ? `Subagent #${id}` : `Root #${id}`;
    return {
      id,
      name: custom ?? derived,
      named: custom !== undefined,
      kind,
      ...(record.parent ? { parentId: record.parent.conversationId as number, forkedAt: record.parent.at as number } : {}),
      ...(record.owner
        ? { ownerAgentId: record.owner.conversationId as number, ownerTaskId: record.owner.taskId as number }
        : {}),
    };
  }

  async list(row: SessionRow, tasks?: TaskNode[]): Promise<AgentSummary[]> {
    const h = this.options.sessions.harness(row);
    const names = this.options.catalog.agentNames(row.id);
    const records = await this.options.sessions.scanAll(h);
    const live = tasks ?? (await this.options.conversations.liveTasks(h));
    return records.map((record) => {
      const own = live.filter((t) => t.conversationId === (record.id as number));
      return {
        ...this.agentRef(record, names),
        busy: own.some((t) => !t.background),
        background: own.filter((t) => t.background).length,
      };
    });
  }

  /** An agent by numeric id, `main`, or unique name (custom or derived, case-insensitive). */
  async resolve(sessionRef: string, agentRef: string): Promise<Resolved> {
    const row = this.options.catalog.resolveSession(sessionRef);
    const h = this.options.sessions.harness(row);
    let id: number | undefined;
    if (/^\d+$/.test(agentRef)) id = Number(agentRef);
    else if (agentRef.toLowerCase() === "main") id = 1;
    else {
      const wanted = agentRef.toLowerCase();
      const names = this.options.catalog.agentNames(row.id);
      const matches = (await this.options.sessions.scanAll(h))
        .map((r) => this.agentRef(r, names))
        .filter((a) => a.name.toLowerCase() === wanted);
      if (matches.length > 1) throw new ApiFault("ambiguous", `${matches.length} agents are named "${agentRef}"`);
      id = matches[0]?.id;
    }
    const c = id === undefined ? undefined : await h.conversation(id as ConversationId, ctx);
    if (!c) throw notFound(`No agent "${agentRef}" in session ${row.name}`);
    return { row, h, c };
  }

  async summary(row: SessionRow, c: Conversation): Promise<AgentSummary> {
    const agents = await this.list(row);
    return agents.find((a) => a.id === (c.id as number))!;
  }

  /** Every tool of the agent's selected extensions, first definition per name, and the names it is offered. */
  private async toolsOf(c: Conversation) {
    const agent = await c.agent(ctx);
    const all = new Map<string, ToolRegistration>();
    for (const extension of agent.extensions)
      for (const tool of extension.tools ?? []) if (!all.has(tool.name)) all.set(tool.name, tool as ToolRegistration);
    return { agent, all: [...all.values()], offered: new Set(agent.tools.map((t) => t.name)) };
  }

  async detail(row: SessionRow, c: Conversation): Promise<AgentDetail> {
    const { agent, all, offered } = await this.toolsOf(c);
    const writers = all.filter(writes);
    return {
      ...(await this.summary(row, c)),
      sessionId: row.id,
      config: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel as ThinkingLevel | undefined,
        instructions: agent.instructions,
        cwd: agent.cwd,
        readOnly: writers.length > 0 && writers.every((t) => !offered.has(t.name)),
      },
      tools: all.map((t) => ({
        name: t.name,
        description: t.description,
        replay: (t.replay ?? "unsafe") as "safe" | "unsafe",
        parameters: JSON.parse(JSON.stringify(t.parameters ?? {})),
        writes: writes(t),
        offered: offered.has(t.name),
      })),
      extensions: agent.extensions.map((e) => e.name),
    };
  }

  setName(row: SessionRow, agentId: number, name: unknown): void {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    const clean = name.trim().slice(0, 100);
    if (/^\d+$/.test(clean) || clean.toLowerCase() === "main" && agentId !== 1)
      throw invalid("Agent names cannot be numbers or 'main'");
    this.options.catalog.setAgentName(row.id, agentId, clean);
  }

  async create(row: SessionRow, body: { from?: unknown; name?: unknown }): Promise<AgentSummary> {
    const h = this.options.sessions.harness(row);
    const source = await this.resolve(row.id, String(body.from ?? 1));
    const agent = await source.c.agent(ctx);
    const other = await h.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: agent.model,
          cwd: agent.cwd,
          thinkingLevel: agent.thinkingLevel,
          instructions: agent.instructions,
        },
      },
      ctx,
    );
    if (typeof body.name === "string" && body.name.trim()) this.setName(row, other.id as number, body.name);
    this.options.changes.notify();
    return this.summary(row, other);
  }

  async fork(row: SessionRow, c: Conversation, body: { entryId?: unknown; name?: unknown }): Promise<AgentSummary> {
    const at = Number(body.entryId);
    if (!Number.isSafeInteger(at)) throw invalid("entryId is required");
    if (body.name !== undefined && typeof body.name !== "string") throw invalid("Invalid fork name");
    const fork = await c.fork(at as EntryId, { ownership: { kind: "ownerless" } }, ctx);
    const agent = await fork.agent(ctx);
    await fork.configure({ model: this.options.models.routed(agent.model) }, ctx);
    if (typeof body.name === "string" && body.name.trim()) this.setName(row, fork.id as number, body.name);
    this.options.changes.notify();
    return this.summary(row, fork);
  }

  async configure(row: SessionRow, c: Conversation, body: Record<string, unknown>): Promise<AgentConfig> {
    const model = body.model === undefined ? undefined : this.options.models.validate(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel))
      throw invalid("Invalid thinking level");
    if (body.instructions !== undefined && typeof body.instructions !== "string")
      throw invalid("instructions must be a string");
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string") throw invalid("cwd must be a string");
      cwd = (await this.options.sessions.browse(body.cwd)).path;
    }
    if (body.readOnly !== undefined && typeof body.readOnly !== "boolean") throw invalid("readOnly must be a boolean");
    // Read only filters the agent's tools: the model is never offered the ones that create, update or delete.
    const tools =
      body.readOnly === true
        ? { tools: { remove: (await this.toolsOf(c)).all.filter(writes) } }
        : body.readOnly === false
          ? { tools: null }
          : {};
    await c.configure(
      {
        ...tools,
        ...(model ? { model } : {}),
        ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as ThinkingLevel } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions.slice(0, 12000) } : {}),
        ...(cwd ? { cwd } : {}),
      },
      ctx,
    );
    if (model && (c.id as number) === 1) this.options.catalog.setSessionModel(row.id, model);
    // Thresholds are shared by the session's agents; refit them when this model's window is too small for them.
    if (model) this.options.compaction.refitFor(row.id, model.modelId);
    this.options.changes.notify();
    return (await this.detail(row, c)).config;
  }
}
