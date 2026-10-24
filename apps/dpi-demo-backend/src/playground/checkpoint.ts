// When a document change is stored as a complete base instead of one more delta.
//
// pi-durable 1.4.0 made `checkpointWhen` required, and the field is the only thing that bounds a read: a document is
// replayed from the newest base plus every delta after it, so a document nobody folds costs more to read the longer
// it lives. Folding costs one full copy of the value and pays it back on every later read, so the number wants to be
// small enough to bound replay and large enough that the base is rare relative to the writes.
//
// 32 is one screenful of deltas. Every document in this pack uses it, including the ones written once per task: a
// receipt never reaches 32 deltas, so the uniform rule costs nothing there and keeps the shape of a definition
// obvious. If a document ever gets expensive enough to want its own number, pass one, and say why in the definition.
import type { CheckpointInfo } from "@earendil-works/pi-durable";

/** Deltas a document may keep after its newest base before the next change is stored as a base. */
export const FOLD_AFTER_DELTAS = 32;

/** The `checkpointWhen` for a document in this pack. */
export const foldEvery =
  (deltas = FOLD_AFTER_DELTAS) =>
  (_value: unknown, _ops: unknown, info: CheckpointInfo) =>
    info.deltasSinceBase >= deltas;
