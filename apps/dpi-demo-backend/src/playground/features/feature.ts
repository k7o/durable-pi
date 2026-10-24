// The feature contract: what one feature contributes to the one playground extension. The assembler in
// playground.ts collects features in a fixed order, because the order in which tools and sections are declared is
// the prompt (PI-208): a new feature goes at the end, and a reorder is a prompt change, not a tidy-up.
//
// Documents are not part of this type. A feature still owns its document (`<feature>/doc.ts`), but the extension
// does not register documents: playground/pack.ts holds the one list of conversation documents, because the device
// also seeds and reads them, and a copy here would be a second list to keep in step.
import type { AnyTask, ToolRegistration } from "@earendil-works/pi-durable";

export type Feature = {
  /** Tools in the order the model is offered them. */
  tools?: readonly ToolRegistration[];
  /** Durable tasks the extension registers by name. */
  tasks?: readonly AnyTask[];
};
