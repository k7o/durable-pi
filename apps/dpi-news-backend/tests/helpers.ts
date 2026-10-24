// Helpers for this app's tests: a temp device on the news pack, and a way to call the tool the way the engine does.
//
// The model is the device's own double (`apps/dpi-backend/src/faux.ts`), which every app on the device can use, so a
// pack's suite never reaches into another pack for one.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTask, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Device } from "../../dpi-backend/src/device.js";
import { faux, fauxModels } from "../../dpi-backend/src/faux.js";
import { createNewsDigest } from "../src/digest.js";
import { createNewsPack } from "../src/pack.js";
import { createNewsTool } from "../src/tool.js";

export { faux };

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => Promise<boolean>, timeout = 15000, what = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(50);
  }
  throw Error(`Timed out waiting for ${what}`);
}

/** A task that stays live until aborted, so a task-scoped document may be written under it. */
const Live = defineTask<Record<string, never>, { phase: "wait" }, undefined>({
  name: "test.news-live",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      await runtime.sleepUntil(runtime.now() + 60_000, task.state.checkpoint, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

/** A temp data dir and working folder, opened as a news device. Reopen with `open()` after a close. */
export async function tempDevice() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-news-")));
  await mkdir(join(root, "work", "project"), { recursive: true });
  const options = {
    dataDir: join(root, "data"),
    startDirs: [join(root, "work")],
    name: "news-test",
    models: await fauxModels(),
  };
  return {
    root,
    work: join(root, "work"),
    options,
    pack: createNewsPack(),
    open: () => Device.open(options, createNewsPack()),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Call the `news` tool the way an agent's tool call does: one live task id for the receipt, one commit function. The
 * task is conversation-owned so the document layer accepts the receipt write.
 */
export async function callTool(store: Device, session: string, args: Record<string, unknown>): Promise<string> {
  const { h, c } = await store.resolveAgent(session, "main");
  const taskId = await h.commit(
    (tx) => tx.createTask(Live, {}, { ownership: { kind: "conversation" }, conversationId: c.id }),
    ctx,
  );
  const api = {
    taskId,
    conversationId: c.id,
    commit: (change: (tx: never) => unknown, commitContext: typeof ctx) => h.commit(change as never, commitContext),
  } as unknown as ToolExecutionApi;
  const tool = createNewsTool(createNewsDigest(store.appState));
  const result = await tool.execute(args as never, api, ctx);
  return (result.output as { type: string; text: string }[])[0].text;
}
