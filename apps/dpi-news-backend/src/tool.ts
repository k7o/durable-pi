// The `news` tool: this conversation's own story list, and the switch that starts a digest run.
//
// Every action runs in one commit together with a task-scoped receipt, so a crash cannot leave the list changed but
// the model uninformed, and a replayed call returns its first result instead of adding the same story twice.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { writing } from "../../dpi-backend/src/tool-policy.js";
import { createNewsDigest } from "./digest.js";
import { Stories, StoryReceipt } from "./stories.js";

export const NEWS_DESCRIPTION =
  "Keep this conversation's news desk: add a story, list it, score it 0-100, or run a digest that summarises the list.";

type DigestTask = ReturnType<typeof createNewsDigest>;

/**
 * The `news` tool. It closes over the digest task definition, which closes over the device's App State, so a pack
 * builds one per session and a test builds the same pair.
 */
export function createNewsTool(digest: DigestTask) {
  return defineTool({
    name: "news",
    description: NEWS_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("add"), Type.Literal("list"), Type.Literal("rank"), Type.Literal("digest")],
        { description: "What to do with the list." },
      ),
      title: Type.Optional(Type.String({ description: "Story title for add. Required for add." })),
      url: Type.Optional(Type.String({ description: "Story link for add. Optional." })),
      id: Type.Optional(Type.String({ description: "Story id from list. Required for rank." })),
      score: Type.Optional(Type.Number({ description: "0-100 for rank. Required for rank.", minimum: 0, maximum: 100 })),
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
        } else {
          // The run is its own durable task, started in this commit so the receipt and the task cannot disagree.
          const taskId = await tx.createTask(
            digest,
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
