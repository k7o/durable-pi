// The `news` tool: this conversation's own story list, and the switches that start a fetch run or a digest run.
//
// Every action runs in one commit together with a task-scoped receipt, so a crash cannot leave the list changed but
// the model uninformed, and a replayed call returns its first result instead of adding the same story twice.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { writing } from "../../dpi-backend/src/pack-api.js";
import { Stories, StoryReceipt } from "./stories.js";
import type { NewsTasks } from "./tasks.js";

export const NEWS_DESCRIPTION =
  "Keep this conversation's news desk: add a story, list it, score it 0-100, fetch the configured feeds, set what the list is about, judge how relevant the unjudged stories are, or run a digest that summarises the list.";

/**
 * The `news` tool. It closes over this app's task definitions, which close over the device's App State, so a pack builds
 * one per session and a test builds the same set — `tasks.ts` is the single place that decides which tasks they are.
 */
export function createNewsTool(tasks: NewsTasks) {
  return defineTool({
    name: "news",
    description: NEWS_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("add"),
          Type.Literal("list"),
          Type.Literal("rank"),
          Type.Literal("fetch"),
          Type.Literal("topics"),
          Type.Literal("triage"),
          Type.Literal("digest"),
        ],
        { description: "What to do with the list." },
      ),
      title: Type.Optional(Type.String({ description: "Story title for add. Required for add." })),
      url: Type.Optional(Type.String({ description: "Story link for add. Optional." })),
      id: Type.Optional(Type.String({ description: "Story id from list. Required for rank." })),
      score: Type.Optional(Type.Number({ description: "0-100 for rank. Required for rank.", minimum: 0, maximum: 100 })),
      topics: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "What this list is about, for topics. Replaces the list: a triage run judges relevance against it, and without it there is nothing to be relevant to.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const text = await api.commit(async (tx) => {
        // A replay after a crash reuses the first result: no duplicate story, no second digest run.
        const receipt = await tx.doc(StoryReceipt, api.taskId);
        if (receipt.applied) return receipt.result;
        const doc = await tx.doc(Stories, api.conversationId);
        let out: string;
        if (args.action === "list") {
          const ranked = doc.items.filter((story) => story.score !== undefined);
          out = JSON.stringify({
            open: doc.items.length - ranked.length,
            ranked: ranked.length,
            runs: doc.runs,
            items: doc.items,
            ...(doc.digest ? { digest: doc.digest } : {}),
            ...(doc.fetch ? { fetch: doc.fetch } : {}),
            ...(doc.topics ? { topics: doc.topics } : {}),
            ...(doc.triage ? { triage: doc.triage } : {}),
          });
        } else if (args.action === "add") {
          const title = args.title?.trim();
          if (!title) throw Error("add needs a title");
          if (title.length > 200) throw Error("title must be 200 characters or less");
          if (args.url !== undefined && !/^https?:\/\//u.test(args.url))
            throw Error("url must start with http:// or https://");
          // The tool call's task id is unique and durable, so it is also the story id.
          const id = `s${api.taskId}`;
          if (!doc.items.some((story) => story.id === id))
            doc.items.push({ id, title, ...(args.url ? { url: args.url } : {}), addedAt: Date.now() });
          out = `Added ${id}: ${title}`;
        } else if (args.action === "rank") {
          const id = args.id?.trim();
          if (!id) throw Error("rank needs an id from list");
          if (args.score === undefined) throw Error("rank needs a score from 0 to 100");
          const story = doc.items.find((item) => item.id === id);
          if (!story) throw Error(`No story ${id}. Use action list for ids.`);
          story.score = Math.round(args.score);
          out = `Ranked ${id} at ${story.score}: ${story.title}`;
        } else if (args.action === "topics") {
          // The criterion every relevance score is measured against, so it is stored on the list rather than in a prompt.
          const topics = (args.topics ?? []).map((topic) => topic.trim()).filter(Boolean);
          if (!topics.length) throw Error("topics needs at least one topic, or omit the action to leave the list alone");
          doc.topics = topics;
          out = `Topics: ${topics.join(", ")}. Run action triage to judge the unjudged stories against them.`;
        } else if (args.action === "triage") {
          const taskId = await tx.createTask(
            tasks.triage,
            {},
            { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true },
          );
          receipt.applied = true;
          receipt.result = `Started triage run as durable task #${taskId}. It scores the unjudged stories 0-100 for relevance and leaves them in place; read the result with action list.`;
          return receipt.result;
        } else if (args.action === "fetch") {
          // One feed per phase invocation, so a restart resumes at the next feed rather than at the first.
          const taskId = await tx.createTask(
            tasks.fetch,
            {},
            { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true },
          );
          receipt.applied = true;
          receipt.result = `Started fetch run as durable task #${taskId}. It reads the configured feeds, adds what the list does not have, and records what each feed did; read the result with action list.`;
          return receipt.result;
        } else {
          // The run is its own durable task, started in this commit so the receipt and the task cannot disagree.
          const taskId = await tx.createTask(
            tasks.digest,
            {},
            { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true },
          );
          receipt.applied = true;
          receipt.result = `Started digest run as durable task #${taskId}. It writes its summary onto the list; read it with action list.`;
          return receipt.result;
        }
        receipt.applied = true;
        receipt.result = out;
        return out;
      }, ctx);
      return { output: [{ type: "text", text }], details: { action: args.action } };
    },
  });
}
