// The feature contract: what one feature contributes to the one playground extension. The assembler in
// playground.ts collects features in a fixed order, because the order in which tools and sections are declared is
// the prompt (PI-208): a new feature goes at the end, and a reorder is a prompt change, not a tidy-up.
import type { AnyTask, DocDefinition, DocToken, JsonObject, PromptSection, ToolRegistration } from "@earendil-works/pi-durable";

// TS-101's one allowed heterogeneous alias: a feature registry holds documents of different types and no precise
// common supertype exists. Confined to this file; no signature or call site takes `any`.
type AnyDoc = DocToken<JsonObject, DocDefinition<JsonObject>>;

export type Feature = {
  /** Documents this feature declares, for the kind registry and the conversation seeder. */
  docs?: readonly AnyDoc[];
  /** Tools in the order the model is offered them. */
  tools?: readonly ToolRegistration[];
  /** Durable tasks the extension registers by name. */
  tasks?: readonly AnyTask[];
  /** The prompt section this feature renders, prepended in assembly order. */
  section?: PromptSection;
};
