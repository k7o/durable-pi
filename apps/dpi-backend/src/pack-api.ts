// What a pack is written against: the one file in the device that a pack may import.
//
// The seam has two halves. `pack.ts` is the interface a pack *implements*; this is the API it *uses* to implement it —
// the device, the shared document policy, the tool policy, the error shapes a route may throw, and the types of the
// objects the device hands over. Keeping them apart is what makes the boundary legible: a pack's `src/` imports this
// file and nothing else from the device, and `tests/layout.test.ts` fails the build if that changes. A pack's tests may
// still reach inside, because a test that stands in for the engine is not product code.
//
// One rule keeps the surface smaller than the device: a type that stands for an object a pack is *handed* is a `Pick`,
// not a class, so `AppStateStore` is the three methods a pack may call and the store's engine stays out of reach. Where
// the device owns a format it exports the function that writes it (`appendStateChange`) instead of the constant a pack
// would have to keep in step.
//
// `Device` is the deliberate exception, because a pack's routes are full-power on purpose. A route is a product
// endpoint, not a sandboxed capability: it resolves agents (which hands back the engine's `Harness` and
// `Conversation`), reads device documents and starts work in its conversation. Narrowing that argument to a `Pick`
// would be theatre — `resolveAgent` alone returns the two widest objects in the system — so the seam restricts what a
// pack *adds* to the device, not what its own code may do at runtime. The same holds for `Models`, whose `open()`
// returns an instance with its engine: a pack that wants a provider is allowed to have one.
//
// This file is also the future package entry: when a pack lives outside this repo, `exports` points here and every
// import in a pack changes by one specifier, not by a hundred. Growing it is a decision about the public API, so add a
// symbol only when a pack needs it, and say which pack in the commit.

// Exported for `Device.open` in a pack's entrypoint and for `routes(device)`; see the note above on why it is not a
// `Pick`. `DEVICE_CAPABILITIES` is what `info()` extends.
export { Device, DEVICE_CAPABILITIES } from "./device.js";
export { Models } from "./models.js";
export { loadConfig } from "./config.js";
export { serve } from "./serve.js";
export { faux, fauxModels } from "./faux.js";
export { foldEvery } from "./pack.js";
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
export type { AppStateStore } from "./app-state.js";
export { appendStateChange } from "./state-tools.js";
export { writing } from "./tool-policy.js";
export { ApiFault, invalid, notFound } from "./errors.js";
