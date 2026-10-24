import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTask, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/packs/demo-jobs.js";
import { TODOS_DOC, type TodosDoc } from "../../dpi-sdk/src/packs/demo-todos.js";
import { TodoTool } from "../src/playground/features/todos/tools.js";
import { bootServer, faux, newToken, tempDevice, until } from "./helpers.js";

test("SIGKILL restart resumes a durable job from its checkpoint with no client attached", async () => {
  const t = await tempDevice();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Crash recovery", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: 4, interval_seconds: 2 } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => ((await run())?.phases[1].progress?.done ?? 0) >= 1, 15000, "first check");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await run())?.status === "completed", 30000, "completion after SIGKILL");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.equal(done.phases[1].steps.filter((s) => s.kind === "checkpoint" && s.status === "done").length, 4);
    const history = await main.entries({ scope: "all" });
    assert.equal(history.items.filter((e) => e.kind === "demo.job").length, 1);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

// A task that stays in its wait phase until the test aborts it. A task-scoped document may only be written while
// its task is not terminal, which is exactly the state an interrupted tool call is in when the engine replays it.
const Live = defineTask<Record<string, never>, { phase: "wait" }, undefined>({
  name: "test.live",
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

test("a replayed todo call applies its edit once: the task-scoped receipt", async () => {
  const t = await tempDevice();
  let store = await t.open();
  try {
    const session = await store.create({ name: "Todo replay", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(session.id, "main");
    const todo = async () => (await store.agentDoc(h, c, TODOS_DOC)) as TodosDoc;
    // A crash between the tool's own commit and its result entry makes the engine rerun execute() with the
    // intent's arguments and the interrupted call's task id. Calling one task id twice is that replay.
    type Args = { action: "list" | "add" | "complete" | "reopen" | "remove"; text?: string; id?: string };
    const call = async (taskId: TaskId, args: Args) => {
      const api = {
        taskId,
        conversationId: c.id,
        commit: (change: (tx: Tx) => unknown, commitContext: Context) => h.commit(change, commitContext),
      } as unknown as ToolExecutionApi;
      const result = await TodoTool.execute(args, api, ctx);
      return (result.output as { type: string; text: string }[])[0].text;
    };
    const tasks: TaskId[] = [];
    const liveTask = async () => {
      const id = await h.commit((tx) => tx.createTask(Live, {}, { ownership: { kind: "conversation" }, conversationId: c.id }), ctx);
      tasks.push(id);
      return id;
    };

    // add twice with the same task id: one item, and the same result both times.
    const addTask = await liveTask();
    const added = `t${addTask}`;
    assert.equal(await call(addTask, { action: "add", text: "write the experiment" }), `Added ${added}: write the experiment`);
    assert.equal(await call(addTask, { action: "add", text: "write the experiment" }), `Added ${added}: write the experiment`);
    assert.deepEqual((await todo()).items.map((i) => [i.id, i.text, i.done]), [[added, "write the experiment", false]]);

    // A different task id is a different call, so the list grows: the replay above was not a no-op by accident.
    const secondTask = await liveTask();
    assert.equal(await call(secondTask, { action: "add", text: "run the digest" }), `Added t${secondTask}: run the digest`);
    assert.equal((await todo()).items.length, 2);

    // complete twice: still done, and the completion time still names the first run.
    const completeTask = await liveTask();
    assert.equal(await call(completeTask, { action: "complete", id: added }), `Completed ${added}: write the experiment`);
    const doneAt = (await todo()).items.find((i) => i.id === added)!.doneAt;
    assert.ok(doneAt);
    await call(completeTask, { action: "complete", id: added });
    const completed = (await todo()).items.find((i) => i.id === added)!;
    assert.equal(completed.done, true);
    assert.equal(completed.doneAt, doneAt);

    // remove twice: the replay reports the removal instead of the "no such item" error the second call would hit.
    const removeTask = await liveTask();
    const removed = `t${secondTask}`;
    assert.equal(await call(removeTask, { action: "remove", id: removed }), `Removed ${removed}: run the digest`);
    assert.equal(await call(removeTask, { action: "remove", id: removed }), `Removed ${removed}: run the digest`);
    assert.deepEqual((await todo()).items.map((i) => i.id), [added]);

    // The document, receipts and all, survives closing and reopening the session's store.
    const items = (await todo()).items;
    for (const id of tasks) await h.abortTask(id, ctx);
    await store.close();
    store = await t.open();
    const again = await store.resolveAgent(session.id, "main");
    assert.deepEqual(((await store.agentDoc(again.h, again.c, TODOS_DOC)) as TodosDoc).items, items);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("SIGKILL restart keeps demo.todos and the digest the job wrote", async () => {
  const t = await tempDevice();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Todo restart", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const todo = async () => (await main.doc<TodosDoc>("demo.todos")).value;
    assert.equal((await main.send("todo: add write the experiment", "followUp", "todo-add", 20000)).status, "done");
    const added = (await todo()).items[0]!;
    assert.equal((await main.send(`todo: complete ${added.id}`, "followUp", "todo-done", 20000)).status, "done");
    assert.equal((await main.send("job: todo-digest", "followUp", "todo-job", 20000)).status, "done");
    await until(async () => (await todo()).digest?.done === 1, 15000, "digest");
    const before = await todo();
    assert.equal(before.items[0]!.done, true);
    assert.match(before.digest!.text, /0 open, 1 done/);

    await server.stop("SIGKILL");
    await server.start();
    const reopened = new DpiClient(server.base, token).agent(s.id, "main");
    const after = (await reopened.doc<TodosDoc>("demo.todos")).value;
    assert.deepEqual(after, before);
    assert.equal(after.items[0]!.done, true);
    assert.match(after.digest!.text, /0 open, 1 done/);
    // The job that wrote it is still reported as completed, so the digest is not a stray document revision.
    const runs = async () => (await reopened.doc<JobRunsDoc>("demo.job-runs")).value.items;
    assert.equal(Object.values(await runs()).find((r) => r.job === "todo-digest")?.status, "completed");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
