// The one assembled `playground` extension: features in, one extension out. This is the only place the order of
// tools and sections is decided, and that order is the prompt (PI-208), so features are listed in the order their
// tools are offered and a new feature goes at the end.
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Feature } from "./features/feature.js";
import { historyTools } from "./features/history/tool.js";
import type { Jobs } from "./features/jobs/engine.js";
import { jobsTools } from "./features/jobs/tools.js";
import { sessionTools } from "./features/sessions/tools.js";
import type { SpawnSession } from "../../../dpi-backend/src/spawn.js";
import { pager } from "./features/side-effects/tool.js";
import { todos } from "./features/todos/tools.js";
import { PLAYGROUND_SECTION } from "./prompt.js";

/**
 * Features in the order their tools are offered. The order is the contract the snapshot test pins: ping_on_call_engineer
 * comes before the session tools because it did before the split, and a reorder is a prompt change.
 */
function features(sessionId: string, spawn: SpawnSession, jobs: Jobs): Feature[] {
  return [todos(), jobsTools(jobs), historyTools(), pager(), sessionTools(sessionId, spawn)];
}

/** Assembles the pack's extension. `read_state` and `update_state` are the device's tools, installed before this one. */
export function createPlayground(sessionId: string, spawn: SpawnSession, jobs: Jobs) {
  const assembled = features(sessionId, spawn, jobs);
  return defineExtension({
    name: "playground",
    tasks: assembled.flatMap((feature) => feature.tasks ?? []),
    tools: assembled.flatMap((feature) => feature.tools ?? []),
    sections: [section("playground", () => PLAYGROUND_SECTION, { tag: false })],
  });
}
