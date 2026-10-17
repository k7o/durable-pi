// Provider selection for this device. One provider is registered per backend; sessions store the
// provider they were created with and are re-routed to this device's provider on open.
//
// OpenRouter stays the default so existing devices keep working unchanged. Direct providers need no
// OpenRouter account and their model catalogs ship with pi-ai, so a device can run on a DeepSeek or
// OpenCode key alone. API keys are read from the environment by the provider factories.
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export const PROVIDER_IDS = ["openrouter", "deepseek", "opencode", "opencode-go", "faux"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** `faux` is the free deterministic model; it takes no credential. */
export const PROVIDER_CREDENTIALS: Record<ProviderId, string[]> = {
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  faux: [],
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Built-in pi-ai provider for an id. `faux` is installed separately by the store. */
export function providerFor(id: Exclude<ProviderId, "faux">) {
  switch (id) {
    case "openrouter":
      return openrouterProvider();
    case "deepseek":
      return deepseekProvider();
    case "opencode":
      return opencodeProvider();
    case "opencode-go":
      return opencodeGoProvider();
  }
}
