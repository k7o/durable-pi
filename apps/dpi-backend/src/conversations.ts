// A conversation's transcript surface: input, submissions, tasks, history, the inbox and usage.
// These are the calls that talk to one pi-durable conversation; none of them needs the device.
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationId,
  EntryId,
  Harness,
  TaskId,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { InboxDoc } from "@earendil-works/pi-durable";
import type {
  InboxItem,
  Page,
  SendResult,
  TaskNode,
  TaskOutcome,
  UsageTotals,
  WhenBusy,
  WireEntry,
} from "../../dpi-sdk/src/api.js";
import { messageText, toMarkdown, toTranscript } from "../../dpi-sdk/src/transcript.js";
import { invalid, notFound } from "./errors.js";
import { JobRuns, jobDef } from "./jobs.js";

const encodeCursor = (cursor: unknown) =>
  cursor === undefined ? undefined : Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (cursor?: string) => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("Invalid cursor");
  }
};

export class Conversations {
  /** Task labels never change once known: tool names of pi.tool tasks, job titles of job runs. */
  private readonly taskLabels = new Map<string, { label?: string; callId?: string }>();

  async send(c: Conversation, body: Record<string, unknown>) {
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000)
      throw invalid("content must be a message under 100,000 characters");
    const whenBusy = (body.whenBusy ?? "followUp") as WhenBusy;
    if (!["steer", "followUp", "reject"].includes(whenBusy)) throw invalid("whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw invalid("requestId is required (≤128 chars) so retries never submit twice");
    return c.submit({ type: "input", content: body.content, requestId: body.requestId, whenBusy }, ctx);
  }

  async settled(h: Harness, submissionId: number, waitMs = 0, signal?: AbortSignal): Promise<SendResult> {
    const submission = await h.submission(submissionId as SubmissionId, ctx);
    if (!submission) throw notFound(`No submission ${submissionId}`);
    let record = await submission.status(ctx);
    if (waitMs > 0 && record.status !== "done" && record.status !== "unanswered") {
      const timeout = AbortSignal.timeout(Math.min(waitMs, 300_000));
      const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        record = await submission.wait(withAbortSignal(stop, ctx));
      } catch (e) {
        if (!stop.aborted) throw e;
      }
    }
    if (record.status === "done" && record.answer !== undefined) {
      const entry = await h.commit((tx) => tx.entry(record.answer as EntryId), ctx);
      const text = (entry?.model ?? []).map((m) => messageText(m as never)).join("").trim();
      return { submissionId, status: "done", answer: { entryId: record.answer as number, text } };
    }
    if (record.status === "unanswered") return { submissionId, status: "unanswered", reason: record.reason };
    return { submissionId, status: record.status === "queued" ? "queued" : "pending" };
  }

  async abort(c: Conversation, background: boolean) {
    await c.abort(ctx, { background });
    return { ok: true as const };
  }

  async withdraw(h: Harness, c: Conversation, submissionId: number) {
    return { status: await h.abortSubmission(submissionId as SubmissionId, ctx, c.id) };
  }

  async compact(c: Conversation, instructions?: unknown) {
    return {
      taskId: (await c.compact(typeof instructions === "string" && instructions.trim() ? instructions : undefined, ctx)) as number,
    };
  }

  async reset(c: Conversation, note?: unknown) {
    await c.reset(typeof note === "string" && note.trim() ? note : undefined, ctx);
    return { ok: true as const };
  }

  async tasks(h: Harness, status: string, limit: number): Promise<TaskOutcome[]> {
    const items = await h.commit(async (tx) => {
      let page = await tx.scanTasks({}, 500);
      let all = [...page.items];
      while (page.next) {
        page = await tx.scanTasks({}, 500, page.next);
        all = [...all, ...page.items].slice(-2000);
      }
      return all;
    }, ctx);
    const wanted = items.filter((t) =>
      status === "terminal" ? t.state.status === "terminal" : t.state.status !== "terminal",
    );
    return wanted.slice(-Math.min(Math.max(limit, 1), 200)).reverse().map((t) => ({
      id: t.id as number,
      kind: (t as { kind?: string }).kind ?? (t as { definition?: string }).definition ?? "task",
      conversationId: (t as { conversationId?: number }).conversationId,
      state: JSON.parse(JSON.stringify(t.state)),
    }));
  }

  async abortTask(h: Harness, taskId: number) {
    const task = await h.getTask(taskId as TaskId, ctx);
    if (!task) throw notFound(`No task ${taskId}`);
    return { status: await h.abortTask(task.id, ctx) };
  }

  async inspect(h: Harness) {
    return h.inspect(ctx);
  }

  async entries(c: Conversation, cursor: string | undefined, limit: number): Promise<Page<WireEntry>> {
    const page = await c.entries({}, Math.min(Math.max(limit, 1), 2000), decodeCursor(cursor), ctx);
    return { items: page.items as unknown as WireEntry[], next: encodeCursor(page.next) };
  }

  async activeEntries(c: Conversation): Promise<WireEntry[]> {
    const view = await c.viewState(ctx);
    try {
      return JSON.parse(JSON.stringify(view.value.entries)) as WireEntry[];
    } finally {
      view.dispose();
    }
  }

  async transcript(c: Conversation, format: string) {
    const items = toTranscript(await this.activeEntries(c));
    return format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items };
  }

  async inbox(h: Harness, c: Conversation): Promise<InboxItem[]> {
    const doc = await h.snapshot(InboxDoc, c.id, ctx);
    return (doc?.items ?? []).map((item) => {
      if (item.mode === "write") return { id: item.id as number, mode: "write" as const, content: "Context update" };
      const content = item.content as unknown;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text : "")).join("")
            : undefined;
      return { id: item.id as number, mode: item.mode, content: text };
    });
  }

  async usage(h: Harness): Promise<UsageTotals> {
    return JSON.parse(JSON.stringify(await h.usage(ctx))) as UsageTotals;
  }

  // ------------------------------------------------------------ live tasks

  async liveTasks(h: Harness): Promise<TaskNode[]> {
    const graph = await h.taskGraph(ctx);
    try {
      return await this.labelTasks(h, Object.values(graph.value.tasks).map((t) => this.taskNode(t)));
    } finally {
      graph.dispose();
    }
  }

  taskNode(t: unknown): TaskNode {
    const n = t as {
      id: number;
      kind: string;
      conversationId: number;
      owner?: number;
      background: boolean;
      abortRequested?: boolean;
      state: { status: string; phase?: string; on?: readonly number[]; policy?: string; outcome?: string };
      conversations?: readonly number[];
    };
    return {
      id: n.id,
      kind: n.kind,
      conversationId: n.conversationId,
      ...(n.owner !== undefined ? { owner: n.owner } : {}),
      background: !!n.background,
      ...(n.abortRequested ? { aborting: true } : {}),
      state: {
        status: n.state.status,
        ...(n.state.phase ? { phase: n.state.phase } : {}),
        ...(n.state.on ? { on: [...n.state.on] } : {}),
        ...(n.state.policy ? { policy: n.state.policy } : {}),
      },
      conversations: [...(n.conversations ?? [])],
    };
  }

  /** Name every pi.tool task by its tool and every job run by its title, so a task list reads like the transcript. */
  async labelTasks(h: Harness, nodes: TaskNode[]): Promise<TaskNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        const key = `${node.conversationId}:${node.id}`;
        let known = this.taskLabels.get(key);
        if (!known) {
          known = await this.taskLabel(h, node).catch(() => undefined);
          if (!known) return node;
          this.taskLabels.set(key, known);
          if (this.taskLabels.size > 5000) this.taskLabels.delete(this.taskLabels.keys().next().value!);
        }
        return { ...node, ...known };
      }),
    );
  }

  private async taskLabel(h: Harness, node: TaskNode): Promise<{ label?: string; callId?: string } | undefined> {
    if (node.kind.startsWith("demo.job.")) {
      const run = (await h.snapshot(JobRuns, node.conversationId as ConversationId, ctx))?.items[String(node.id)];
      const def = jobDef(node.kind.slice("demo.job.".length));
      return def ? { label: run ? `${def.title} #${run.run}` : def.title } : undefined;
    }
    if (node.kind !== "pi.tool") return undefined;
    const task = await h.getTask(node.id as TaskId, ctx);
    const input = task?.input as { assistant?: number; callId?: string } | undefined;
    if (!input?.callId || input.assistant === undefined) return undefined;
    const entry = await h.commit((tx) => tx.entry(input.assistant as EntryId), ctx);
    for (const m of (entry?.model ?? []) as unknown as { role: string; content?: { type: string; id?: string; name?: string }[] }[])
      for (const b of m.role === "assistant" ? (m.content ?? []) : [])
        if (b.type === "toolCall" && b.id === input.callId) return { label: b.name, callId: input.callId };
    return { callId: input.callId };
  }
}
