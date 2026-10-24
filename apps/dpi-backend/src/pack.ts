// The pack seam: what a device needs from the product built on it. The device owns boot, HTTP, sessions, agents,
// durability and the stores every pack shares (App State); a pack owns the conversation documents, the extensions
// installed in a session and any extra routes. Three packs exist — the empty one below, the demo app's and the news
// app's — so this is one small interface, not a plugin framework.
import type { Router } from "express";
import type { CheckpointInfo, Conversation, ConversationId, Extension, Harness, Tx } from "@earendil-works/pi-durable";
import type { AppStateStore } from "./app-state.js";
import type { DeviceInfo, TaskNode } from "../../dpi-sdk/src/api.js";
import type { Models } from "./models.js";
import type { SpawnSession } from "./spawn.js";
import type { Device } from "./device.js";

/**
 * Deltas a document keeps after its newest base before the next change is stored as a base. pi-durable 1.4.0 requires
 * every `defineDoc` to answer this, and it is the only thing bounding what a read replays, so it lives here beside the
 * interface rather than in each pack: 32 is small enough to keep replay short and large enough that a base, which
 * copies the whole value, stays rare.
 */
export const FOLD_AFTER_DELTAS = 32;

/** The `checkpointWhen` for a document on a device. */
export const foldEvery =
  (deltas = FOLD_AFTER_DELTAS) =>
  (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
    info.deltasSinceBase >= deltas;

/** A conversation document a pack adds: a new conversation seeds it, and `GET .../docs/:kind` reads it. */
export interface ConversationDoc {
  readonly kind: string;
  /** What a client sees before the document is written for the first time. */
  readonly empty: unknown;
  seed(tx: Tx, conversationId: ConversationId): Promise<unknown>;
  read(h: Harness, conversationId: ConversationId): Promise<unknown>;
}

/** A device-scoped document a pack adds: `GET /v1/docs/:kind`. */
export interface DeviceDoc {
  readonly kind: string;
  /** The value a client reads, plus a revision when the store versions it. */
  read(): Promise<{ value: unknown; revision?: number }>;
}

/** A built-in prompt an extension renders, which a client toggles per agent. */
export interface PackPrompt {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly text: string;
}

/** A custom extension a session installs but does not select, plus what the Extensions panel shows for it. */
export interface PackExtension {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly extension: Extension;
  readonly prompts?: readonly PackPrompt[];
}

/** The custom extensions of a pack: installed in every session, selected per agent. */
export interface PackExtensions {
  /** In the order the Extensions panel lists them. */
  readonly list: readonly PackExtension[];
  /** The prompt ids this agent's prompt checklist renders. */
  prompts(h: Harness, conversationId: ConversationId): Promise<readonly string[]>;
  /** Turn one built-in prompt on or off for this agent. */
  setPrompt(c: Conversation, id: string, enabled: boolean): Promise<void>;
}

/** What one session gets from its pack: extensions in install order, before the agent picks extras. */
export interface PackSession {
  install(deps: { sessionId: string }): readonly Extension[];
}

export interface DevicePack {
  readonly name: string;
  /** Conversation documents, in seeding order. A client's subscription list adds the matching kinds. */
  readonly docs?: readonly ConversationDoc[];
  /** Device-scoped documents; none in the device's default pack. */
  readonly deviceDocs?: readonly DeviceDoc[];
  /**
   * Run once, before any session, after the device has opened its own stores. `appState` is the device's App State:
   * read and change it here (or in a tool) with `snapshot()` and `change()`, and `seed()` only the keys this pack owns,
   * so two packs can share the document. `notify` wakes the device's change feed.
   */
  open?(deps: { dataDir: string; appState: AppStateStore; notify: () => void }): Promise<void>;
  /** Release what `open` acquired. Safe to call twice. */
  close?(): Promise<void>;
  createSession(deps: { spawn: SpawnSession; appState: AppStateStore }): PackSession;
  /**
   * The models this pack supplies when the device is asked for a provider the device itself does not ship, today
   * only `DPI_PROVIDER=faux`. Without it the device refuses that provider, so the demo app is the only place the
   * free deterministic model exists.
   */
  models?(): Promise<Models>;
  /** Custom extensions installed but not selected in every session. */
  readonly sessionExtensions?: PackExtensions;
  /** Extra `/v1` routes, mounted behind the same token middleware. */
  routes?(device: Device): Router;
  /** Merged into `GET /v1/device` — this is where `jobs` and the demo capability come from. */
  info?(): Partial<DeviceInfo>;
  /** Title a task this pack owns; undefined falls through to the device's own labels. */
  labelTask?(task: TaskNode, h: Harness): Promise<{ label?: string; callId?: string } | undefined>;
}

/** A device with no product on it: no agent documents, no agent tools beyond the coding ones, no extra routes. */
export const EMPTY_PACK: DevicePack = {
  name: "device",
  createSession: () => ({ install: () => [] }),
};
