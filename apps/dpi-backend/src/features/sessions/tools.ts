// The session tools: delegate to a child conversation, start an independent session on this device, and hand off
// to a fresh context. `spawn` creates the session once per tool call key.
import { isAbsolute, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineTool } from "@earendil-works/pi-durable";
import { THINKING_LEVELS } from "../../../../dpi-sdk/src/api.js";
import { TOOL_DESCRIPTIONS } from "../../prompt.js";
import { writing } from "../../tool-policy.js";
import type { Feature } from "../feature.js";
import type { SpawnSession } from "./types.js";

export function sessionTools(sessionId: string, spawn: SpawnSession): Feature {
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

  return { tools: [writing(subagent), writing(startSession), handoff] };
}
