import type { SharedState } from "./shared-state.js";
import { Type } from "@earendil-works/pi-ai";
import { isAbsolute, resolve } from "node:path";
import { readState, type AppState } from "../../dpi-sdk/src/app-state.js";
import type { SessionSummary, ThinkingLevel } from "../../dpi-sdk/src/api.js";
import { THINKING_LEVELS } from "../../dpi-sdk/src/api.js";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { jobRunDone, type JobRun } from "../../dpi-sdk/src/jobs.js";
import {
  defineDoc,
  defineTool,
  defineExtension,
  section,
  configure,
  AssistantEntry,
  type EntryRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { jobDef, resolveJobInput } from "./features/jobs/defs.js";
import type { Jobs } from "./features/jobs/engine.js";
import { JobRuns } from "./features/jobs/record.js";
import { searchHistory } from "./history.js";
import { Todos } from "./todos.js";
import { PLAYGROUND_SECTION, TOOL_DESCRIPTIONS } from "./prompt.js";
import { writing } from "./tool-policy.js";

export const Workspace = defineDoc<AppState>({
  kind: "demo.workspace",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ goal: "Explore durable agents", counter: 0, notes: [] }),
});
const Receipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
});
/** ping_on_call_engineer pages once per agent; this records the page. */
const Pager = defineDoc<{ paged: boolean; at: number; page: string; summary: string }>({
  kind: "demo.pager",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paged: false, at: 0, page: "", summary: "" }),
});
/** One receipt per tool call: a replay after a crash returns this result instead of editing the list twice. */
const TodoReceipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.todo-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
});

/** The `todo` tool. It closes over nothing, so one definition serves every conversation and a test can drive it directly. */
export const TodoTool = defineTool({
  name: "todo",
  description: TOOL_DESCRIPTIONS.todo,
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("add"), Type.Literal("complete"), Type.Literal("reopen"), Type.Literal("remove")],
      { description: "What to do with the list." },
    ),
    text: Type.Optional(Type.String({ description: "Item text for add. Required for add." })),
    id: Type.Optional(Type.String({ description: "Item id from list. Required for complete, reopen and remove." })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const text = await api.commit(async (tx) => {
      // A replay after a crash reuses the first result: no duplicate add, no double toggle.
      const receipt = await tx.doc(TodoReceipt, api.taskId);
      if (receipt.applied) return receipt.result;
      const doc = await tx.doc(Todos, api.conversationId);
      let out: string;
      if (args.action === "list") {
        out = JSON.stringify({
          open: doc.items.filter((i) => !i.done).length,
          done: doc.items.filter((i) => i.done).length,
          items: doc.items,
        });
      } else if (args.action === "add") {
        const value = args.text?.trim();
        if (!value) throw Error("add needs text");
        if (value.length > 280) throw Error("text must be 280 characters or less");
        // The tool call's task id is unique and durable, so it is also the item id.
        const id = `t${api.taskId}`;
        if (!doc.items.some((i) => i.id === id)) doc.items.push({ id, text: value, done: false, createdAt: Date.now() });
        out = `Added ${id}: ${value}`;
      } else {
        const id = args.id?.trim();
        if (!id) throw Error(`${args.action} needs an item id from list`);
        const item = doc.items.find((i) => i.id === id);
        if (!item) throw Error(`No todo item ${id}. Use action list for ids.`);
        if (args.action === "complete") {
          item.done = true;
          item.doneAt ??= Date.now();
          out = `Completed ${id}: ${item.text}`;
        } else if (args.action === "reopen") {
          item.done = false;
          delete item.doneAt;
          out = `Reopened ${id}: ${item.text}`;
        } else {
          doc.items = doc.items.filter((i) => i.id !== id);
          out = `Removed ${id}: ${item.text}`;
        }
      }
      receipt.applied = true;
      receipt.result = out;
      return out;
    }, ctx);
    return { content: [{ type: "text", text }], details: { action: args.action } };
  },
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One line per phase change, for the run_durable_job call's live output. */
function progressLines(run: JobRun) {
  return run.phases.flatMap((phase, i) => {
    const n = `${i + 1}/${run.phases.length} ${phase.label}`;
    if (phase.status === "done") return [`✓ ${n}: ${phase.summary ?? "done"}`];
    if (phase.status === "running") return [`▸ ${n}`];
    if (phase.status === "waiting") return [`⏸ ${n}: waiting for a person to approve in the chat`];
    if (phase.status === "failed" || phase.status === "aborted") return [`✗ ${n}: ${phase.summary ?? phase.status}`];
    return [];
  });
}

const phaseLabel = (run: JobRun) => run.phases.find((p) => p.id === run.phase)?.label;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One run as check_durable_job reports it: compact enough for a model, complete enough to act on. */
function runReport(run: JobRun, now: number) {
  return {
    taskId: run.id,
    job: run.job,
    title: run.title,
    run: run.run,
    status: run.status,
    ...(jobRunDone(run) ? {} : { phase: phaseLabel(run) }),
    ...(run.approval === "pending" ? { next: "Waiting for a person to approve in the chat" } : {}),
    ...(run.approval && run.approval !== "pending" ? { approval: run.approval } : {}),
    startedBy: run.startedBy,
    background: run.background,
    seconds: Math.round(((run.endedAt ?? now) - run.startedAt) / 100) / 10,
    ...(run.resumed ? { resumedAfterRestart: run.resumed } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    phases: run.phases.map((p) => ({
      phase: p.label,
      status: p.status,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.progress ? { progress: `${p.progress.done}/${p.progress.total}` } : {}),
      ...(p.steps.length
        ? { steps: p.steps.map((s) => `${s.status} ${s.kind} ${s.label}${s.detail ? `: ${clip(s.detail.replace(/\s+/g, " "), 160)}` : ""}`) }
        : {}),
    })),
  };
}

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;

export function createPlayground(shared: SharedState, sessionId: string, spawn: SpawnSession, jobs: Jobs) {
  const readAppState = defineTool({
    name: "read_state",
    description: TOOL_DESCRIPTIONS.read_state,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await shared.snapshot();
      return {
        content: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }],
      };
    },
  });
  const updateState = defineTool({
    name: "update_state",
    description: TOOL_DESCRIPTIONS.update_state,
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("increment"),
      ]),
      path: Type.String(),
      value_json: Type.Optional(
        Type.String({
          description:
            "JSON-encoded value. Objects and arrays must be encoded as JSON here, not passed as native tool argument objects.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const next = await shared.change(
        {
          operation: args.operation,
          path: args.path,
          value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
        },
        `agent:${sessionId}:${api.taskId}`,
      );
      const value = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (!receipt.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: "demo.state-change",
            data: { taskId: api.taskId, text: `App State: ${args.operation} ${args.path || "/"}` },
          });
          receipt.applied = true;
          receipt.result = JSON.stringify(next);
        }
        return receipt.result;
      }, ctx);
      return { content: [{ type: "text", text: value }] };
    },
  });
  const recentRuns = async (api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) =>
    Object.values((await api.snapshot(JobRuns, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
  const listJobs = defineTool({
    name: "list_durable_jobs",
    description: TOOL_DESCRIPTIONS.list_durable_jobs,
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              jobs.defs.map((d) => ({
                job: d.id,
                title: d.title,
                summary: d.summary,
                phases: d.phases.map((p) => `${p.label}: ${p.summary}`),
                inputs: Object.fromEntries(
                  d.inputs.map((i) => [
                    i.name,
                    { type: i.type, default: i.default, ...(i.min !== undefined ? { min: i.min, max: i.max } : {}), description: i.description },
                  ]),
                ),
                needsApproval: d.approval,
                savesTo: d.resultPath,
                typicalSeconds: d.seconds,
                recentRuns: runs
                  .filter((r) => r.job === d.id)
                  .slice(0, 5)
                  .map((r) => ({ taskId: r.id, run: r.run, status: r.status, phase: phaseLabel(r) })),
              })),
            ),
          },
        ],
      };
    },
  });
  const runJob = defineTool({
    name: "run_durable_job",
    description: TOOL_DESCRIPTIONS.run_durable_job,
    parameters: Type.Object({
      job: Type.String({ description: "Job id from list_durable_jobs." }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description: "The job's inputs by name. Omitted inputs use their defaults.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the run to finish, including any approval. Default false." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const def = jobDef(args.job);
      if (!def) throw Error(`Unknown job ${args.job}. Jobs: ${jobs.defs.map((d) => d.id).join(", ")}`);
      const input = resolveJobInput(def, args.input ?? {});
      const wait = args.wait === true;
      // A replay after a crash finds the run this call started instead of starting another.
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return Number(receipt.result);
        const id = await jobs.start(tx, api.conversationId, {
          def,
          input,
          startedBy: "agent",
          toolCallId: api.callId,
          ...(wait ? { owner: api.taskId } : {}),
          now: Date.now(),
        });
        receipt.applied = true;
        receipt.result = String(id);
        return id as number;
      }, ctx);
      await api.details({ taskId, job: def.id }, ctx);
      const read = async () => (await api.snapshot(JobRuns, api.conversationId, ctx))?.items[String(taskId)];
      if (!wait) {
        const run = await read();
        return {
          content: [
            {
              type: "text",
              text: `Started ${def.title} run #${run?.run ?? "?"} as durable task #${taskId}. It runs in the background, shows live in the chat and saves its result to App State ${def.resultPath}. Check it with check_durable_job {"task_id":${taskId}}.`,
            },
          ],
          details: { taskId, job: def.id },
        };
      }
      const printed = new Set<string>();
      let run = await read();
      for (;;) {
        for (const line of run ? progressLines(run) : [])
          if (!printed.has(line)) {
            printed.add(line);
            api.output(`${line}\n`);
          }
        if (!run || jobRunDone(run)) break;
        await pause(400);
        run = await read();
      }
      const ok = run?.status === "completed";
      return {
        content: [
          {
            type: "text",
            text: run
              ? `${def.title} run #${run.run} ${run.status}${ok ? `: ${run.result}` : run.error ? `: ${run.error}` : ""}.\n${progressLines(run).join("\n")}${ok ? `\nResult saved to App State ${def.resultPath}.` : ""}`
              : `${def.title} task #${taskId} has no record.`,
          },
        ],
        isError: !ok,
        details: { taskId, job: def.id },
      };
    },
  });
  const checkJob = defineTool({
    name: "check_durable_job",
    description: TOOL_DESCRIPTIONS.check_durable_job,
    parameters: Type.Object({
      task_id: Type.Optional(Type.Integer({ minimum: 1, description: "The run's task id." })),
      job: Type.Optional(Type.String({ description: "A job id: check its latest run." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      const run =
        args.task_id !== undefined
          ? runs.find((r) => r.id === args.task_id)
          : args.job !== undefined
            ? runs.find((r) => r.job === args.job)
            : undefined;
      if (args.task_id === undefined && args.job === undefined)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                runs.slice(0, 10).map((r) => ({ taskId: r.id, job: r.job, run: r.run, status: r.status, phase: phaseLabel(r) })),
              ),
            },
          ],
        };
      if (!run)
        throw Error(
          `No run ${args.task_id !== undefined ? `with task id ${args.task_id}` : `of ${args.job}`} in this conversation. Runs: ${runs.map((r) => `${r.id} (${r.job} #${r.run})`).join(", ") || "none"}`,
        );
      return { content: [{ type: "text", text: JSON.stringify(runReport(run, Date.now())) }] };
    },
  });
  const searchHistoryTool = defineTool({
    name: "search_history",
    description: TOOL_DESCRIPTIONS.search_history,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words that must all appear, case-insensitive." })),
      tool: Type.Optional(Type.String({ description: "Only calls to and results from this tool, for example bash." })),
      entry: Type.Optional(Type.Integer({ minimum: 1, description: "Read this one entry in full." })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("tool_call"),
          Type.Literal("tool_result"),
          Type.Literal("event"),
        ]),
      ),
      from_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Oldest entry number to include." })),
      to_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Newest entry number to include." })),
      order: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results per page. Default 10." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Results to skip. Default 0." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { entries, activeFrom } = await api.commit(async (tx) => {
        const all: EntryRecord[] = [];
        let page = await tx.scanEntries({ conversationId: api.conversationId }, 500);
        all.push(...page.items);
        while (page.next && all.length < 10_000) {
          page = await tx.scanEntries({ conversationId: api.conversationId }, 500, page.next);
          all.push(...page.items);
        }
        return { entries: all, activeFrom: (await tx.latestHeadMarker(api.conversationId))?.head as number | undefined };
      }, ctx);
      const resets = entries.filter((e) => e.kind === "pi.reset").map((e) => e.id as number);
      const result = searchHistory(entries as unknown as WireEntry[], args, {
        activeFrom,
        lastReset: resets.length ? Math.max(...resets) : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never pages twice.
  const pingOnCall = defineTool({
    name: "ping_on_call_engineer",
    description: TOOL_DESCRIPTIONS.ping_on_call_engineer,
    parameters: Type.Object({
      summary: Type.String({ description: "What the engineer needs to know, one or two sentences." }),
      severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("critical")])),
    }),
    execute: async (args, api, ctx) => {
      const prior = await api.snapshot(Pager, api.conversationId, ctx);
      if (prior?.paged)
        throw Error(
          `Already paged at ${new Date(prior.at).toISOString()} (${prior.page}). ping_on_call_engineer works once per agent.`,
        );
      const severity = args.severity ?? "high";
      const page = `PG-${String(api.taskId).padStart(4, "0")}`;
      api.output("Dialing the on-call engineer…\n");
      await pause(1500);
      await api.commit(async (tx) => {
        const pager = await tx.doc(Pager, api.conversationId);
        if (pager.paged) throw Error(`Already paged (${pager.page}).`);
        Object.assign(pager, { paged: true, at: Date.now(), page, summary: args.summary.slice(0, 300) });
      }, ctx);
      api.output(`Paged on-call, ${severity} severity: ${page}\nWaiting for acknowledgement…\n`);
      await pause(1500);
      api.output("Acknowledged.\n");
      return {
        content: [
          {
            type: "text",
            text: `Paged the on-call engineer (${page}, ${severity}). They acknowledged. Do not page again for this.`,
          },
        ],
      };
    },
  });
  const subagent = defineTool({
    name: "subagent",
    description: TOOL_DESCRIPTIONS.subagent,
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const id = await api.commit(async (tx) => {
        const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (found) return found.id;
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, child.id, { tools: { remove: [subagent] } });
        return child.id;
      }, ctx);
      await api.details({ conversationId: id }, ctx);
      const child = await api.conversation(id, ctx);
      if (!child) throw Error("Child missing");
      const result = await (
        await child.submit(
          { type: "input", content: args.task, requestId: `child:${api.taskId}` },
          ctx,
        )
      ).wait(ctx);
      const answer =
        result.status === "done" && result.type === "input"
          ? await api.commit((tx) => tx.entry(AssistantEntry, result.answer), ctx)
          : undefined;
      return {
        content: [
          { type: "text", text: answer ? JSON.stringify(answer.model) : JSON.stringify(result) },
        ],
        details: { conversationId: id },
      };
    },
  });
  const startSession = defineTool({
    name: "start_session",
    description: TOOL_DESCRIPTIONS.start_session,
    parameters: Type.Object({
      name: Type.String({ description: "Session name shown in the network tree." }),
      cwd: Type.String({
        description: "Existing folder on this device. Relative paths resolve against your working directory.",
      }),
      model: Type.Optional(
        Type.String({ description: "Model id from this device's model list. Default: your current model." }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "First message for the new session. Default: none, the session starts idle." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const parent = await api.agent(ctx);
      if (!parent.model) throw Error("This agent has no model to copy");
      const cwd = args.cwd.startsWith("~") || isAbsolute(args.cwd) ? args.cwd : resolve(parent.cwd ?? ".", args.cwd);
      const thinking = THINKING_LEVELS.find((level) => level === parent.thinkingLevel);
      const { session, submissionId } = await spawn({
        key: `start_session:${sessionId}:${api.taskId}`,
        name: args.name,
        cwd,
        model: { provider: parent.model.provider, modelId: args.model ?? parent.model.modelId },
        thinkingLevel: thinking,
        prompt: args.prompt?.trim() || undefined,
      });
      const sent =
        submissionId === undefined
          ? "It has no prompt yet."
          : `Sent its first message as submission #${submissionId}. It runs on its own.`;
      return {
        content: [
          {
            type: "text",
            text: `Started session "${session.name}" (${session.id}) in ${session.cwd} with ${session.model}. ${sent}`,
          },
        ],
        details: { sessionId: session.id, ...(submissionId === undefined ? {} : { submissionId }) },
      };
    },
  });
  const handoff = defineTool({
    name: "handoff",
    description: TOOL_DESCRIPTIONS.handoff,
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args) => ({
      content: [{ type: "text", text: "Context handed off." }],
      control: { handoff: args.note },
    }),
  });
  return defineExtension({
    name: "playground",
    tasks: jobs.tasks,
    tools: [
      readAppState,
      writing(updateState),
      writing(TodoTool),
      listJobs,
      writing(runJob),
      checkJob,
      searchHistoryTool,
      writing(pingOnCall),
      writing(subagent),
      writing(startSession),
      handoff,
    ],
    sections: [
      section(
        "playground",
        () =>
          PLAYGROUND_SECTION,
        { tag: false },
      ),
    ],
  });
}
