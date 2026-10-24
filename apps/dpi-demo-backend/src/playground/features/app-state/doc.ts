// The playground's shared App State document: one JSON object that every agent, session, conversation and fork reads
// and edits. Rewindable, so the UI can rewind it; a fork starts from the current object, not a historical copy.
import { defineDoc } from "@earendil-works/pi-durable";
import type { AppState } from "../../../../../dpi-sdk/src/app-state.js";
import { foldEvery } from "../../checkpoint.js";

export const WORKSPACE_DOC = "demo.workspace";

export const Workspace = defineDoc<AppState>({
  kind: WORKSPACE_DOC,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ goal: "Explore durable agents", counter: 0, notes: [] }),
  checkpointWhen: foldEvery(),
});
