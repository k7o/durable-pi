// The documents a client may read, built from the pack: the conversation documents a new conversation seeds, and the
// device-scoped documents `GET /v1/docs/:kind` serves. One list each, so a document cannot be registered in one place
// and seeded in another.
import type { Conversation, ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import { notFound } from "./errors.js";
import type { ConversationDoc, DeviceDoc, DevicePack } from "./pack.js";

export class Documents {
  private readonly agentDocs: readonly ConversationDoc[];
  private readonly deviceDocs: readonly DeviceDoc[];

  constructor(pack: DevicePack) {
    this.agentDocs = pack.docs ?? [];
    this.deviceDocs = pack.deviceDocs ?? [];
  }

  /** The agent document kinds a client may subscribe to. */
  get agentKinds(): readonly string[] {
    return this.agentDocs.map((doc) => doc.kind);
  }

  /** The device document kinds a client may subscribe to. */
  get deviceKinds(): readonly string[] {
    return this.deviceDocs.map((doc) => doc.kind);
  }

  /** Create every conversation document of a new conversation, in seeding order. */
  async seed(tx: Tx, conversationId: ConversationId) {
    for (const doc of this.agentDocs) await doc.seed(tx, conversationId);
  }

  async agentDoc(h: Harness, c: Conversation, kind: string) {
    const doc = this.agentDocs.find((entry) => entry.kind === kind);
    if (!doc) throw notFound(`Unknown agent document ${kind}. Known: ${this.agentKinds.join(", ")}`);
    const value = await doc.read(h, c.id);
    return JSON.parse(JSON.stringify(value ?? doc.empty)) as unknown;
  }

  async deviceDoc(kind: string): Promise<{ value: unknown; revision?: number }> {
    const doc = this.deviceDocs.find((entry) => entry.kind === kind);
    if (!doc) throw notFound(`Unknown device document ${kind}`);
    return doc.read();
  }
}
