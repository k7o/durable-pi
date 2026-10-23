// The offered tools, job ids and phase ids, and document kinds are contract, not implementation detail: tool and
// section order is prompt order (PI-208), and run records and clients store the ids (DP-104). This snapshot fails
// when a list is reordered, before the prompt cache does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_DOC_KINDS, DEVICE_DOC_KINDS } from "../src/documents.js";
import { createPlayground, type SpawnSession } from "../src/extensions.js";
import { JOB_DEFS, type Jobs } from "../src/jobs.js";
import { TOOL_DESCRIPTIONS } from "../src/prompt.js";
import type { SharedState } from "../src/shared-state.js";

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

test("contracts: document kinds", () => {
  // Kinds are a rename contract, not an order contract: the agent kinds are the keys of one registry and the plan
  // seeds conversations in a different order (Workspace, JobRuns, Todos), so pinning the key order here would only
  // fight the seeding list that slice 6 collapses.
  assert.deepEqual([...AGENT_DOC_KINDS].sort(), ["demo.job-runs", "demo.todos", "demo.workspace"]);
  assert.deepEqual([...DEVICE_DOC_KINDS].sort(), ["app.shared-state"]);
});
