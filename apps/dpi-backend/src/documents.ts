// The documents a client may read: the device's shared App State, and the per-conversation documents the backend
// declares. One list per job that needs it, so a new conversation document cannot be registered in one place and
// seeded in another: the kind registry, the seeder and the reads all come from CONVERSATION_DOCS below.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { AppState } from "../../dpi-sdk/src/app-state.js";
import { JOB_RUNS_DOC } from "../../dpi-sdk/src/jobs.js";
import { TODOS_DOC } from "../../dpi-sdk/src/todos.js";
import { notFound } from "./errors.js";
import { WORKSPACE_DOC, Workspace } from "./features/app-state/doc.js";
import { JobRuns } from "./features/jobs/record.js";
import { Todos } from "./features/todos/doc.js";
import type { SharedState } from "./shared-state.js";

export const APP_STATE_DOC = "app.shared-state";
export const DEVICE_DOC_KINDS = [APP_STATE_DOC];

type ConversationDoc = {
  readonly kind: string;
  /** What a client sees before the document is written for the first time. */
  readonly empty: unknown;
  readonly seed: (tx: Tx, conversationId: ConversationId) => Promise<unknown>;
  readonly read: (h: Harness, conversationId: ConversationId) => Promise<unknown>;
};

/**
 * Conversation documents in seeding order: Workspace, JobRuns, Todos. The seeder has always created them in that
 * order and a client does not depend on it, so this list is the one place that decides it.
 */
const CONVERSATION_DOCS: readonly ConversationDoc[] = [
  { kind: WORKSPACE_DOC, empty: {}, seed: (tx, id) => tx.doc(Workspace, id), read: (h, id) => h.snapshot(Workspace, id, ctx) },
  {
    kind: JOB_RUNS_DOC,
    empty: { counts: {}, items: {} },
    seed: (tx, id) => tx.doc(JobRuns, id),
    read: (h, id) => h.snapshot(JobRuns, id, ctx),
  },
  { kind: TODOS_DOC, empty: { items: [] }, seed: (tx, id) => tx.doc(Todos, id), read: (h, id) => h.snapshot(Todos, id, ctx) },
];

export const AGENT_DOC_KINDS = CONVERSATION_DOCS.map((doc) => doc.kind);

/** Create every conversation document of a new conversation, in seeding order. */
export async function seedConversation(tx: Tx, conversationId: ConversationId) {
  for (const doc of CONVERSATION_DOCS) await doc.seed(tx, conversationId);
}

export class Documents {
  constructor(private readonly shared: SharedState) {}

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    const doc = CONVERSATION_DOCS.find((entry) => entry.kind === kind);
    if (!doc) throw notFound(`Unknown agent document ${kind}. Known: ${AGENT_DOC_KINDS.join(", ")}`);
    const value = await doc.read(h, c.id);
    return JSON.parse(JSON.stringify(value ?? doc.empty)) as unknown;
  }

  async deviceDoc(kind: string): Promise<{ value: AppState; revision: number }> {
    if (kind !== APP_STATE_DOC) throw notFound(`Unknown device document ${kind}`);
    return this.shared.snapshot();
  }
}
