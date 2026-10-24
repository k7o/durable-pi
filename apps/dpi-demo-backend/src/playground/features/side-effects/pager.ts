// The pager's state. ping_on_call_engineer works once per conversation, and this records the page it sent so a
// second call can refuse instead of paging again.
import { defineDoc } from "@earendil-works/pi-durable";

/** ping_on_call_engineer pages once per agent; this records the page. */
export const Pager = defineDoc<{ paged: boolean; at: number; page: string; summary: string }>({
  kind: "demo.pager",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paged: false, at: 0, page: "", summary: "" }),
});
