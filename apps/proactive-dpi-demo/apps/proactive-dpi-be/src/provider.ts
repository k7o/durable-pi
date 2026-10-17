// Provider selection for the demo. One provider is registered per run; the incident agent, the Ops
// desk and the model picker all follow it. OpenRouter stays the default so an existing setup keeps
// working, and the direct providers need no OpenRouter account. API keys come from the environment.
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export const PROVIDER_IDS = ["openrouter", "deepseek", "opencode", "opencode-go"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_CREDENTIALS: Record<ProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerFor(id: ProviderId) {
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
