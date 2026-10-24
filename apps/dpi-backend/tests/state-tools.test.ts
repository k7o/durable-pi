// App State and its two tools are the device's, so a bare device — no pack at all — has them. This is the test that
// keeps them from drifting back into a pack, and it drives the pair the way a tool call does, replay included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTask, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Device } from "../src/device.js";
import { faux, fauxModels } from "../src/faux.js";
import { STATE_ENTRY_KIND, stateTools } from "../src/state-tools.js";

/** A task that stays live until aborted, so a task-scoped document may be written under it. */
const Live = defineTask<Record<string, never>, { phase: "wait" }, undefined>({
  name: "test.state-live",
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

test("state tools: a bare device offers both, and one update is one atomic change", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-state-")));
  await mkdir(join(root, "work"), { recursive: true });
  const device = await Device.open({
    dataDir: join(root, "data"),
    startDirs: [join(root, "work")],
    name: "bare",
    models: await fauxModels(),
  });
  try {
    const session = await device.create({ name: "Bare", cwd: join(root, "work"), model: faux });
    const { row, h, c } = await device.resolveAgent(session.id, "main");

    const detail = await device.agentDetail(row, c);
    const offered = detail.tools.filter((tool) => tool.offered).map((tool) => tool.name);
    assert.ok(offered.includes("read_state") && offered.includes("update_state"), offered.join(", "));
    assert.ok(!offered.includes("todo"), "a bare device has no pack tools");
    assert.equal(detail.tools.find((tool) => tool.name === "update_state")?.writes, true);

    // Every call mints its own live task, the way the engine does for a tool call: the receipts are keyed by it.
    const liveTask = () =>
      h.commit((tx) => tx.createTask(Live, {}, { ownership: { kind: "conversation" }, conversationId: c.id }), ctx);
    const [readTool, updateTool] = stateTools(device.appState, row.id).tools!;
    const text = async (tool: typeof readTool, args: Record<string, unknown>, taskId?: number) => {
      const task = taskId ?? (await liveTask());
      const api = {
        taskId: task,
        conversationId: c.id,
        commit: (change: (tx: never) => unknown, commitContext: typeof ctx) => h.commit(change as never, commitContext),
      } as unknown as ToolExecutionApi;
      const result = await tool.execute(args as never, api, ctx);
      return (result.output as { type: string; text: string }[])[0].text;
    };

    assert.deepEqual(JSON.parse(await text(readTool, {})), {});
    assert.match(await text(updateTool, { operation: "create", path: "/counter", value_json: "2" }), /"counter":2/);
    assert.match(await text(updateTool, { operation: "increment", path: "/counter", value_json: "3" }), /"counter":5/);
    assert.equal(JSON.parse(await text(readTool, { path: "/counter" })), 5);
    assert.deepEqual((await device.appState.snapshot()).value, { counter: 5 });

    // The change is recorded once, under the device's own entry kind, next to the tool call.
    const entries = (await device.entries(c, undefined, 50)).items.filter((e) => e.kind === STATE_ENTRY_KIND);
    assert.deepEqual(
      entries.map((e) => (e.data as { text: string }).text).sort(),
      ["App State: create /counter", "App State: increment /counter"],
    );

    // A replay — the same task id and arguments — applies nothing and appends no second entry.
    const replayed = await liveTask();
    assert.match(
      await text(updateTool, { operation: "increment", path: "/counter", value_json: "2" }, replayed),
      /"counter":7/,
    );
    assert.match(
      await text(updateTool, { operation: "increment", path: "/counter", value_json: "2" }, replayed),
      /"counter":7/,
    );
    assert.deepEqual((await device.appState.snapshot()).value, { counter: 7 });
    assert.equal(
      (await device.entries(c, undefined, 50)).items.filter((e) => e.kind === STATE_ENTRY_KIND).length,
      3,
    );

    // A stale revision is refused, and a missing field is an error rather than a silent create.
    await assert.rejects(() => device.appState.change({ operation: "update", path: "/nope", value: 1 }), /does not exist/);
  } finally {
    await device.close();
    await rm(root, { recursive: true, force: true });
  }
});
