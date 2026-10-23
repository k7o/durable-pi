// The offered tools, job ids and phase ids, and document kinds are contract, not implementation detail: tool and
// section order is prompt order (PI-208), and run records and clients store the ids (DP-104). This snapshot fails
// when a list is reordered, before the prompt cache does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_DOC_KINDS, DEVICE_DOC_KINDS } from "../src/documents.js";
import { createPlayground, type SpawnSession } from "../src/extensions.js";
import { JOB_DEFS, type Jobs } from "../src/jobs.js";
import type { SharedState } from "../src/shared-state.js";

test("contracts: the extension offers the same tools in the same order", () => {
  // Assembly only reads `jobs.tasks`; every other argument is reached from inside execute(), so the snapshot needs
  // no database, no session and no store. Throwing stubs make that assumption fail loudly if it ever changes.
  const refuse = () => {
    throw Error("contract snapshot: this argument is not exercised by assembly");
  };
  const extension = createPlayground(
    {} as unknown as SharedState,
    "contract-session",
    refuse as unknown as SpawnSession,
    { defs: JOB_DEFS, tasks: [], start: refuse } as unknown as Jobs,
  );

  assert.deepEqual(
    extension.tools?.map((tool) => tool.name),
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
  assert.deepEqual(AGENT_DOC_KINDS, ["demo.job-runs", "demo.todos", "demo.workspace"]);
  assert.deepEqual(DEVICE_DOC_KINDS, ["app.shared-state"]);
});
