// The Phase object a job handler receives. Everything that writes the run record, runs shell commands, reads App
// State or drives a subagent is here, so a job module only names its phases and what they do.
import type { Context } from "@earendil-works/chord";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import { CodingTools, createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { readState } from "../../../../../dpi-sdk/src/app-state.js";
import type { WireAssistantMessage, WireMessage, WireToolResultMessage } from "../../../../../dpi-sdk/src/api.js";
import type { JobDef } from "../../../../../dpi-sdk/src/api.js";
import type { JobPhaseRun, JobRun } from "../../../../../dpi-sdk/src/packs/demo-jobs.js";
import { messageText } from "../../../../../dpi-sdk/src/transcript.js";
import { runOf, upsertStep, type Run, type Running } from "./record.js";
import { clip } from "./shared.js";
import type { JobsDeps, Phase } from "./types.js";

const CHILD_INSTRUCTIONS =
  "You are one phase of a durable job. Use only the commands and files the task names. Never edit or write files. Answer in at most 5 short lines.";
const tail = (s: string, lines = 8) => s.trim().split("\n").slice(-lines).join("\n");

export const phaseApi = (deps: JobsDeps, def: JobDef, index: number, task: Running, runtime: Run, ctx: Context, run: JobRun): Phase => {
  const spec = def.phases[index];
  const cp = task.state.checkpoint;
  let counter = 0;
  const record = (fn: (run: JobRun, phase: JobPhaseRun) => void) =>
    runtime.commit(async (tx) => {
      const current = await runOf(tx, task);
      fn(current, current.phases[index]);
      current.updatedAt = runtime.now();
      return undefined;
    }, ctx);
  const shell = async (command: string) => {
    const env = await runtime.env(ctx);
    if (!env) throw Error("This session has no execution environment");
    let out = "";
    const result = await env.exec(command, { timeout: 60, onOutput: (text) => void (out.length < 50_000 && (out += text)) }, ctx);
    if (!result.ok) throw Error(`${command}: ${result.error.message}`);
    return { code: result.value.exitCode, out };
  };
  const step: Phase["step"] = async (kind, text, fn) => {
    const id = `${spec.id}:${cp.iteration}:${counter++}`;
    const at = runtime.now();
    await record((_r, phase) => upsertStep(phase, { id, kind, label: text, status: "running", iteration: cp.iteration, at }));
    try {
      const { value, detail } = await fn();
      await record((_r, phase) =>
        upsertStep(phase, { id, kind, label: text, status: "done", iteration: cp.iteration, at, ms: runtime.now() - at, ...(detail ? { detail: clip(detail, 600) } : {}) }),
      );
      return value;
    } catch (e) {
      if (!runtime.signal.aborted)
        await record((_r, phase) =>
          upsertStep(phase, { id, kind, label: text, status: "error", iteration: cp.iteration, at, ms: runtime.now() - at, detail: clip(String((e as Error)?.message ?? e), 600) }),
        );
      throw e;
    }
  };
  const stateKey = (path: string) => `job:${deps.sessionId}:${task.id}:${spec.id}:${cp.iteration}:${path}`;
  return {
    input: task.input.input,
    data: cp.data,
    iteration: cp.iteration,
    run: { id: task.id as number, n: run.run },
    now: () => runtime.now(),
    shell,
    step,
    exec: (command, text) =>
      step("command", text ?? command, async () => {
        const r = await shell(command);
        if (r.code !== 0) throw Error(`Exit ${r.code}: ${tail(r.out, 4)}`);
        return { value: r.out, detail: tail(r.out) || "(no output)" };
      }),
    note: (text, detail) => step("note", text, async () => ({ value: undefined, detail })),
    progress: (done, total) => record((_r, phase) => void (phase.progress = { done, total })),
    saveState: (path, value) =>
      step("state", `update_state ${path}`, async () => {
        const [, top] = path.split("/");
        const { value: root } = await deps.shared.snapshot();
        const parent = root[top];
        if (!parent || typeof parent !== "object" || Array.isArray(parent))
          await deps.shared.change({ operation: parent === undefined ? "create" : "update", path: `/${top}`, value: {} }, `${stateKey(path)}:parent`);
        const exists = (await deps.shared.snapshot()).value[top] as Record<string, unknown>;
        const key = path.split("/").slice(2).join("/");
        await deps.shared.change(
          { operation: Object.hasOwn(exists ?? {}, key) ? "update" : "create", path, value },
          stateKey(path),
        );
        return { value: undefined, detail: clip(JSON.stringify(value), 300) };
      }),
    readState: async (path) => {
      try {
        return readState((await deps.shared.snapshot()).value, path);
      } catch {
        return undefined;
      }
    },
    todos: async () => (await runtime.snapshot(deps.todos, task.conversationId, ctx)) ?? { items: [] },
    saveTodoDigest: (digest) =>
      runtime.commit(async (tx) => {
        (await tx.doc(deps.todos, task.conversationId)).digest = digest;
        return undefined;
      }, ctx),
    agent: async (prompt) => {
      let childId = 0;
      const stepId = `${spec.id}:${cp.iteration}:agent`;
      const at = runtime.now();
      await runtime.commit(async (tx) => {
        const found = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
        if (found) childId = found.id as number;
        else {
          const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
          await configure(tx, child.id, {
            extensions: [CodingTools],
            tools: [createReadTool(), createBashTool()],
            instructions: CHILD_INSTRUCTIONS,
          });
          childId = child.id as number;
        }
        const current = await runOf(tx, task);
        current.childConversationId = childId;
        upsertStep(current.phases[index], {
          id: stepId,
          kind: "agent",
          label: `Subagent #${childId}`,
          detail: "Working with read and bash",
          status: "running",
          iteration: cp.iteration,
          at,
          conversationId: childId,
        });
        return undefined;
      }, ctx);
      const handle = await runtime.conversation(childId as ConversationId, ctx);
      if (!handle) throw Error(`Subagent #${childId} is missing`);
      const submission = await handle.submit(
        { type: "input", content: prompt, requestId: `job:${task.id}:${spec.id}` },
        ctx,
      );
      const settled = submission.wait(ctx);
      // Mirror the subagent's tool calls into the run record while it works; each call is its own pi.tool task.
      let seen = "";
      const sync = async () => {
        const view = await runtime.context(childId as ConversationId, ctx);
        const results = new Map<string, boolean>();
        const calls: { id: string; name: string; args: unknown }[] = [];
        for (const entry of view.entries) {
          for (const m of (entry.model ?? []) as unknown as WireMessage[]) {
            if (m.role === "toolResult") {
              const r = m as WireToolResultMessage;
              results.set(r.toolCallId, r.isError);
            }
            if (m.role === "assistant")
              for (const b of (m as WireAssistantMessage).content)
                if (b.type === "toolCall") calls.push({ id: b.id, name: b.name, args: b.arguments });
          }
        }
        const key = JSON.stringify(calls.map((c) => [c.id, results.get(c.id)]));
        if (key === seen) return view;
        seen = key;
        await record((_r, phase) => {
          for (const c of calls) {
            const id = `${spec.id}:${cp.iteration}:tool:${c.id}`;
            const prior = phase.steps.find((s) => s.id === id);
            const status = !results.has(c.id) ? "running" : results.get(c.id) ? "error" : "done";
            const started = prior?.at ?? runtime.now();
            upsertStep(phase, {
              id,
              kind: "tool",
              label: c.name,
              detail: clip(summarizeArgs(c.args), 160),
              status,
              iteration: cp.iteration,
              at: started,
              conversationId: childId,
              // Only a call seen running has a measured duration; one that finished between polls has none.
              ...(status !== "running" && prior ? { ms: prior.ms ?? runtime.now() - started } : {}),
            });
          }
        });
        return view;
      };
      let done: Awaited<typeof settled> | undefined;
      while (!done) {
        runtime.signal.throwIfAborted();
        done = await Promise.race([
          settled,
          new Promise<void>((resolve) => runtime.setTimer(resolve, 600)).then(
            () => undefined,
            () => undefined,
          ),
        ]);
        await sync();
      }
      const view = await sync();
      const answer = done.status === "done" && done.type === "input" ? view.entries.find((e) => e.id === done.answer) : undefined;
      const text = answer ? ((answer.model ?? []) as unknown as WireMessage[]).map(messageText).join("").trim() : "";
      await record((_r, phase) =>
        upsertStep(phase, {
          id: stepId,
          kind: "agent",
          label: `Subagent #${childId}`,
          detail: clip(text || `Ended: ${done.status}`, 600),
          status: text ? "done" : "error",
          iteration: cp.iteration,
          at,
          ms: runtime.now() - at,
          conversationId: childId,
        }),
      );
      if (!text) throw Error(`Subagent #${childId} returned no answer (${done.status})`);
      return text;
    },
  };
};

function summarizeArgs(args: unknown) {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  return JSON.stringify(args);
}
