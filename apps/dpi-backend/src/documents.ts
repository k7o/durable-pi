// The documents a client may read: the device's shared App State and the per-conversation documents
// declared by the backend's extensions. One registry, so routes and streams agree on the kinds.
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AppState } from "../../dpi-sdk/src/app-state.js";
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";
import { notFound } from "./errors.js";
import { Workspace } from "./extensions.js";
import { JobRuns } from "./jobs.js";
import type { SharedState } from "./shared-state.js";
import { Todos, TODOS_DOC } from "./todos.js";

const AGENT_DOCS = { [JOB_RUNS_DOC]: JobRuns, [TODOS_DOC]: Todos, "demo.workspace": Workspace } as const;

export const AGENT_DOC_KINDS = Object.keys(AGENT_DOCS);
export const DEVICE_DOC_KINDS = ["app.shared-state"];

export class Documents {
  constructor(private readonly shared: SharedState) {}

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    const token = AGENT_DOCS[kind as keyof typeof AGENT_DOCS];
    if (!token) throw notFound(`Unknown agent document ${kind}. Known: ${AGENT_DOC_KINDS.join(", ")}`);
    const value = await h.snapshot(token as typeof JobRuns, c.id, ctx);
    const empty = kind === JOB_RUNS_DOC ? { counts: {}, items: {} } : kind === TODOS_DOC ? { items: [] } : {};
    return JSON.parse(JSON.stringify(value ?? empty)) as unknown;
  }

  async deviceDoc(kind: string): Promise<{ value: AppState; revision: number }> {
    if (kind !== "app.shared-state") throw notFound(`Unknown device document ${kind}`);
    return this.shared.snapshot();
  }
}
