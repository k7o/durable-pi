// Source: https://agenticengineer.com/model-stack, retrieved 2026-10-05.
// Active S+, S, A and B models, matched to https://openrouter.ai/api/v1/models.
// Gemini 4 Argon is rolling out and has no OpenRouter listing at this snapshot.
//
// This is the OpenRouter shortlist. DeepSeek, OpenCode and OpenCode Go ship their own catalogs with
// pi-ai, so the picker lists all of theirs rather than a hand-maintained subset here.
import type { ProviderId } from "./provider.js";

export type CuratedModel = { id: string; name: string; tier: string; icon: string };

export const curatedModels: readonly CuratedModel[] = [
  {
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-fable-5.1",
    name: "Claude Fable 5.1",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-astra",
    name: "GPT-6 Astra",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-opus-5",
    name: "Opus 5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-fable-5",
    name: "Fable 5",
    tier: "S",
    icon: "anthropic.png",
  },
  {
    id: "meta/muse-spark-1.3",
    name: "Muse Spark 1.3",
    tier: "S",
    icon: "meta.png",
  },
  {
    id: "openai/gpt-6-sol",
    name: "GPT-6 Sol",
    tier: "S",
    icon: "openai.png",
  },
  {
    id: "x-ai/grok-4.7",
    name: "Grok 4.7",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "xiaomi/mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    tier: "S",
    icon: "xiaomi.png",
  },
  {
    id: "x-ai/grok-4.6",
    name: "Grok 4.6",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "z-ai/glm-5.3",
    name: "GLM-5.3",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    tier: "A",
    icon: "kimi.png",
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT 5.6 Terra",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "qwen/qwen3.8-2.4t-a95b",
    name: "Qwen3.8-2.4T-A95B",
    tier: "A",
    icon: "qwen.png",
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Sonnet 5",
    tier: "A",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    tier: "A",
    icon: "xiaomi.png",
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "deepseek/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM-5.2",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    tier: "B",
    icon: "zai.png",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    tier: "B",
    icon: "gemini.png",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax-M3",
    tier: "B",
    icon: "minimax.png",
  },
  {
    id: "google/gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    tier: "B",
    icon: "gemini.png",
  },
];

/** Providers with a shortlist show only these in the picker; the rest show their whole catalog. */
export const curatedByProvider: Partial<Record<ProviderId, readonly CuratedModel[]>> = {
  openrouter: curatedModels,
};

/** Used when neither `DPI_MODEL` nor a session names a model. */
export const defaultModelByProvider: Record<ProviderId, string> = {
  openrouter: "anthropic/claude-sonnet-5.5",
  deepseek: "deepseek-v4-pro",
  opencode: "deepseek-v4.1-flash",
  "opencode-go": "deepseek-v4.1-flash",
  faux: "echo",
};

/** Vendor badge for a catalog model, which carries no icon of its own. */
const VENDOR_ICONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude|^anthropic/, "anthropic.png"],
  [/^gpt|^o[1-9]|^openai/, "openai.png"],
  [/^gemini|^google/, "gemini.png"],
  [/^deepseek/, "deepseek.png"],
  [/^glm|^z-ai/, "zai.png"],
  [/^kimi|^moonshot/, "kimi.png"],
  [/^qwen/, "qwen.png"],
  [/^minimax/, "minimax.png"],
  [/^mimo|^xiaomi/, "xiaomi.png"],
  [/^grok|^x-ai/, "grok.png"],
  [/^muse|^meta|^llama/, "meta.png"],
];

/** The subset of a pi-ai chat model this catalog reads. */
export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  cost: { input: number; output: number };
};

/**
 * No external ranking covers the direct providers, so their tier is a cost band on output price per
 * million tokens: S at $10+, A at $3+, B at $1+, C below. It orders the picker, nothing more.
 */
function costTier(output: number): string {
  if (output >= 10) return "S";
  if (output >= 3) return "A";
  if (output >= 1) return "B";
  return "C";
}

/** A model from a direct provider's own catalog, in the shape clients render. */
export function describeModel(
  provider: ProviderId,
  model: CatalogModel,
): CuratedModel & CatalogModel & { provider: ProviderId } {
  const icon = VENDOR_ICONS.find(([pattern]) => pattern.test(model.id))?.[1] ?? "lab.png";
  return {
    id: model.id,
    provider,
    name: model.name,
    tier: costTier(model.cost.output),
    icon,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    cost: { input: model.cost.input, output: model.cost.output },
  };
}
