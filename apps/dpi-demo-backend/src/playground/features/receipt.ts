// The write receipt, one task-scoped document per tool call. A replay after a crash finds `applied` set and returns
// the first result, so an interrupted call never applies its edit twice. update_state and run_durable_job share the
// definition because a task id belongs to exactly one call.
import { defineDoc } from "@earendil-works/pi-durable";
import { foldEvery } from "../checkpoint.js";

export const Receipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: foldEvery(),
});
