// App State: the one JSON document every session and agent on a device reads and changes. It is the device's store, not
// a pack's, because two packs on one device share it: the demo pack seeds `goal`, `counter` and `notes`, any pack may
// add its own keys, and a client reads the whole document at `GET /v1/docs/app.shared-state`.
//
// `Data` is the value, `Meta` its revision and whether anything has ever seeded it, and `Receipts` the per-call receipts
// that make a replayed write return its first result. Every change is one atomic path operation, so two agents never
// overwrite each other's fields, and a writer holding a stale revision is refused.
import { Harness, createRegistry, defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  APP_STATE_DOC,
  changeState,
  replaceState,
  type AppState,
  type StateChange,
} from "../../dpi-sdk/src/app-state.js";
import { foldEvery } from "./pack.js";

const Data = defineDoc<AppState>({
  kind: APP_STATE_DOC,
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: foldEvery(),
});
const Meta = defineDoc<{ initialized: boolean; revision: number }>({
  kind: "app.shared-state-meta",
  version: 1,
  scope: "session",
  initial: () => ({ initialized: false, revision: 0 }),
  checkpointWhen: foldEvery(),
});
const Receipts = defineDocFamily<{ applied: boolean; result: string }, null>({
  kind: "app.shared-state-receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: foldEvery(),
});

export class SharedState {
  private constructor(readonly harness: Harness) {}

  static async open(path: string) {
    return new SharedState(
      await Harness.open(
        await openNodeSqliteStorage(path),
        { models: createModels(), registry: createRegistry() },
        ctx,
      ),
    );
  }

  /**
   * Fill in the keys this pack owns, and nothing else. Idempotent, so a restart does not bump the revision: a document
   * that already has the key keeps its value, which is what makes two packs able to share one App State.
   */
  async seed(defaults: AppState) {
    await this.harness.commit(async (tx) => {
      const data = await tx.doc(Data);
      const missing = Object.entries(defaults).filter(([key]) => !Object.hasOwn(data, key));
      if (!missing.length) return;
      const meta = await tx.doc(Meta);
      for (const [key, value] of missing) data[key] = value;
      meta.initialized = true;
      meta.revision++;
    }, ctx);
  }

  async snapshot() {
    return this.harness.commit(async (tx) => {
      const data = await tx.doc(Data);
      const meta = await tx.doc(Meta);
      return { value: JSON.parse(JSON.stringify(data)) as AppState, revision: meta.revision };
    }, ctx);
  }

  async change(change: StateChange, receiptKey?: string, expectedRevision?: number) {
    return this.harness.commit(async (tx) => {
      const receipt = receiptKey ? await tx.doc(Receipts, receiptKey, null) : undefined;
      if (receipt?.applied) return JSON.parse(receipt.result) as AppState;
      const data = await tx.doc(Data);
      const meta = await tx.doc(Meta);
      if (expectedRevision !== undefined && expectedRevision !== meta.revision)
        throw Error("App State changed while you were editing. Load the latest JSON before saving.");
      const next = changeState(data, change);
      replaceState(data, next);
      meta.revision++;
      if (receipt) {
        receipt.applied = true;
        receipt.result = JSON.stringify(next);
      }
      return next;
    }, ctx);
  }

  async close() {
    await this.harness.close(ctx);
  }
}

/**
 * What a pack may do with App State: read it, change it, seed the keys it owns. The store stays the device's, so a pack
 * cannot close it, and the engine behind it stays out of reach — `SharedState` carries its `harness`, and a `Pick` of
 * three methods is the whole difference between a pack using the document and a pack driving the device.
 */
export type AppStateStore = Pick<SharedState, "snapshot" | "change" | "seed">;
