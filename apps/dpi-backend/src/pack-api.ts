// What a pack is written against: the one file in the device that a pack may import.
//
// The seam has two halves. `pack.ts` is the interface a pack *implements*; this is the API it *uses* to implement it —
// the device, its stores, the shared document policy, the tool policy, the error shapes a route may throw, and the
// types of the objects the device hands over. Keeping them apart is what makes the boundary legible: a pack's `src/`
// imports this file and nothing else from the device, and `tests/layout.test.ts` fails the build if that changes. A
// pack's tests may still reach inside, because a test that stands in for the engine is not product code.
//
// This file is also the future package entry: when a pack lives outside this repo, `exports` points here and every
// import in a pack changes by one specifier, not by a hundred. Growing it is a decision about the public API, so add a
// symbol only when a pack needs it, and say which pack in the commit.
export { Device, DEVICE_CAPABILITIES } from "./device.js";
export { Models } from "./models.js";
export { loadConfig } from "./config.js";
export { serve } from "./serve.js";
export { faux, fauxModels } from "./faux.js";
export { FOLD_AFTER_DELTAS, foldEvery } from "./pack.js";
export type {
  ConversationDoc,
  DeviceDoc,
  DevicePack,
  PackExtension,
  PackExtensions,
  PackPrompt,
  PackSession,
} from "./pack.js";
export type { SpawnSession } from "./spawn.js";
export { SharedState } from "./app-state.js";
export { STATE_ENTRY_KIND } from "./state-tools.js";
export { writing } from "./tool-policy.js";
export { ApiFault, invalid, notFound } from "./errors.js";
