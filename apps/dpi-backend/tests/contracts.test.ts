// The offered tools, job ids and phase ids, document kinds, HTTP routes and device-info keys are contract, not
// implementation detail: tool and section order is prompt order (PI-208), and run records and clients store the ids
// (DP-104). This snapshot fails when a list is reordered or loses an entry, before the prompt cache does.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AGENT_DOC_KINDS, DEVICE_DOC_KINDS } from "../src/documents.js";
import { v1 } from "../src/routes.js";
import { tempDevice } from "./helpers.js";
import type { SpawnSession } from "../src/playground/features/sessions/types.js";
import { createPlayground } from "../src/playground/playground.js";
import { JOB_DEFS } from "../src/playground/features/jobs/defs.js";
import type { Jobs } from "../src/playground/features/jobs/engine.js";
import { TOOL_DESCRIPTIONS } from "../src/playground/prompt.js";
import type { SharedState } from "../src/playground/shared-state.js";

/**
 * The assembled extension, with every argument that assembly is not allowed to touch replaced by a throwing stub.
 * Only `jobs.tasks` is read while assembling; the rest is reached from inside `execute()`. If a later change reads
 * one of these at assembly time, the stub fails the test instead of hiding behind a plausible-looking value.
 */
function playground() {
  const refuse = () => {
    throw Error("contract snapshot: this argument is not exercised by assembly");
  };
  return createPlayground(
    refuse as unknown as SharedState,
    "contract-session",
    refuse as unknown as SpawnSession,
    { defs: JOB_DEFS, tasks: [], start: refuse } as unknown as Jobs,
  );
}

test("contracts: the extension offers the same tools in the same order", () => {
  assert.deepEqual(
    playground().tools?.map((tool) => tool.name),
    [
      "read_state",
      "update_state",
      "todo",
      "list_durable_jobs",
      "run_durable_job",
      "check_durable_job",
      "search_history",
      "ping_on_call_engineer",
      "subagent",
      "start_session",
      "handoff",
    ],
  );
});

test("contracts: the prompt text is keyed by tool name, in the offered order", () => {
  // The descriptions are prompt (PI-208), so a stale key or a reordered entry is a behavior change. Comparing the
  // keys with the offered names ties the prompt table to the tool list without a third hand-kept copy of either.
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS), playground().tools?.map((tool) => tool.name));
});

test("contracts: job ids and their phase ids in order", () => {
  assert.deepEqual(
    JOB_DEFS.map((def) => def.id),
    ["workspace-snapshot", "release-check", "change-watch", "todo-digest"],
  );
  assert.deepEqual(
    JOB_DEFS.map((def) => def.phases.map((phase) => phase.id)),
    [
      ["scan", "measure", "save", "verify"],
      ["plan", "gather", "approve", "publish", "verify"],
      ["baseline", "watch", "report"],
      ["digest"],
    ],
  );
});

/** One `METHOD path` per route, including the routes of a mounted router. */
function routes(app: express.Express): string[] {
  type Layer = { name: string; route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
  const walk = (stack: Layer[]): string[] =>
    stack.flatMap((layer) => {
      if (layer.route)
        return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`);
      if (layer.name === "router" && layer.handle?.stack) return walk(layer.handle.stack);
      return [];
    });
  return walk((app as unknown as { router: { stack: Layer[] } }).router.stack);
}

test("contracts: the v1 routes", async () => {
  const t = await tempDevice();
  const device = await t.open();
  try {
    const app = express();
    app.use("/v1", v1(device));
    assert.deepEqual(routes(app).sort(), [
      "DELETE /sessions/:s",
      "DELETE /sessions/:s/agents/:a/inbox/:submissionId",
      "GET /device",
      "GET /docs/:kind",
      "GET /events",
      "GET /fs/dirs",
      "GET /sessions",
      "GET /sessions/:s",
      "GET /sessions/:s/agents",
      "GET /sessions/:s/agents/:a",
      "GET /sessions/:s/agents/:a/config",
      "GET /sessions/:s/agents/:a/docs/:kind",
      "GET /sessions/:s/agents/:a/entries",
      "GET /sessions/:s/agents/:a/events",
      "GET /sessions/:s/agents/:a/extensions",
      "GET /sessions/:s/agents/:a/transcript",
      "GET /sessions/:s/compaction",
      "GET /sessions/:s/events",
      "GET /sessions/:s/inspect",
      "GET /sessions/:s/submissions/:id",
      "GET /sessions/:s/tasks",
      "GET /tree",
      "PATCH /sessions/:s",
      "PATCH /sessions/:s/agents/:a",
      "PATCH /sessions/:s/agents/:a/config",
      "PATCH /sessions/:s/agents/:a/extensions",
      "PATCH /sessions/:s/compaction",
      "POST /sessions",
      "POST /sessions/:s/agents",
      "POST /sessions/:s/agents/:a/abort",
      "POST /sessions/:s/agents/:a/compact",
      "POST /sessions/:s/agents/:a/demo/jobs",
      "POST /sessions/:s/agents/:a/demo/jobs/:taskId/approval",
      "POST /sessions/:s/agents/:a/demo/state",
      "POST /sessions/:s/agents/:a/fork",
      "POST /sessions/:s/agents/:a/messages",
      "POST /sessions/:s/agents/:a/reset",
      "POST /sessions/:s/tasks/:taskId/abort",
    ]);
  } finally {
    await device.close();
    await t.cleanup();
  }
});

test("contracts: GET /v1/device keys", async () => {
  const t = await tempDevice();
  const device = await t.open();
  try {
    const info = device.deviceInfo();
    assert.deepEqual(Object.keys(info).sort(), [
      "apiVersion",
      "capabilities",
      "codeDir",
      "defaultModel",
      "durableVersion",
      "hostname",
      "jobs",
      "models",
      "name",
      "platform",
      "startDirs",
      "startedAt",
      "storage",
      "uid",
    ]);
    assert.deepEqual(info.capabilities, ["events", "docs", "demo", "jobs"]);
    assert.deepEqual(info.jobs?.map((job) => job.id), ["workspace-snapshot", "release-check", "change-watch", "todo-digest"]);
  } finally {
    await device.close();
    await t.cleanup();
  }
});

test("contracts: document kinds", () => {
  // Kinds are a rename contract, not an order contract: the agent kinds are the keys of one registry and the plan
  // seeds conversations in a different order (Workspace, JobRuns, Todos), so pinning the key order here would only
  // fight the seeding list that slice 6 collapses.
  assert.deepEqual([...AGENT_DOC_KINDS].sort(), ["demo.job-runs", "demo.todos", "demo.workspace"]);
  assert.deepEqual([...DEVICE_DOC_KINDS].sort(), ["app.shared-state"]);
});
