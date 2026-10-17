// Source: https://agenticengineer.com/model-stack, retrieved 2026-10-05.
// Active S+, S, A and B models, matched to https://openrouter.ai/api/v1/models.
// Gemini 4 Argon is rolling out and has no OpenRouter listing at this snapshot.
//
// This is the OpenRouter shortlist, from the model-stack snapshot above. The direct providers are
// curated below from the catalog pi-ai ships for them, at the same pi-ai version the demo pins.
import type { ProviderId } from "./provider.ts";

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

/**
 * Providers with a shortlist show only these in the picker; the rest show their whole catalog
 * (OpenCode Zen, whose catalog covers every vendor it resells).
 *
 * `tier` is the model-stack tier where that snapshot lists the same model, and otherwise the cost
 * band from `costTier` below, marked `// band`. An id a newer pi-ai drops simply stops rendering.
 */
export const curatedByProvider: Partial<Record<ProviderId, readonly CuratedModel[]>> = {
  openrouter: curatedModels,

  // OpenCode Go. Same models as the snapshot's vendor-prefixed OpenRouter ids, on a cheaper plan:
  // its deepseek-v4.1-flash is half Zen's price for the identical model.
  "opencode-go": [
    { id: "kimi-k3", name: "Kimi K3", tier: "A", icon: "kimi.png" },
    { id: "glm-5.3", name: "GLM-5.3", tier: "A", icon: "zai.png" },
    { id: "glm-5.2", name: "GLM-5.2", tier: "A", icon: "zai.png" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", tier: "B", icon: "zai.png" },
    { id: "grok-4.7", name: "Grok 4.7", tier: "S", icon: "grok.png" },
    { id: "grok-4.6", name: "Grok 4.6", tier: "S", icon: "grok.png" },
    { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", tier: "S", icon: "xiaomi.png" },
    { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", tier: "A", icon: "xiaomi.png" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", tier: "A", icon: "deepseek.png" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "A", icon: "deepseek.png" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", tier: "A", icon: "openai.png" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", tier: "A", icon: "openai.png" },
    { id: "minimax-m3", name: "MiniMax-M3", tier: "B", icon: "minimax.png" },
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", tier: "S", icon: "meta.png" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", tier: "A", icon: "kimi.png" }, // band
    { id: "minimax-m2.7", name: "MiniMax-M2.7", tier: "B", icon: "minimax.png" }, // band
    { id: "qwen3.8-max", name: "Qwen3.8 Max", tier: "A", icon: "qwen.png" }, // band
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", tier: "C", icon: "qwen.png" }, // band
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", tier: "B", icon: "qwen.png" }, // band
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", tier: "C", icon: "deepseek.png" }, // band
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision", tier: "C", icon: "deepseek.png" }, // band
    { id: "hy4-preview", name: "Hy4 preview", tier: "B", icon: "lab.png" }, // band
    { id: "hy3", name: "Hy3", tier: "C", icon: "lab.png" }, // band
    { id: "longcat-2.0", name: "LongCat-2.0", tier: "B", icon: "lab.png" }, // band
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", tier: "C", icon: "lab.png" }, // band
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", tier: "C", icon: "xiaomi.png" }, // band
    { id: "mimo-v2.5", name: "MiMo V2.5", tier: "C", icon: "xiaomi.png" }, // band
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", tier: "C", icon: "meta.png" }, // band
    { id: "space-bunny-free", name: "Space Bunny Free", tier: "C", icon: "lab.png" }, // band
  ],

  // DeepSeek direct. Both are the models the snapshot lists as A.
  deepseek: [
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", tier: "A", icon: "deepseek.png" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "A", icon: "deepseek.png" },
  ],
};

/** Used when neither `--model` nor `DPI_MODEL` names one. */
export const defaultModelByProvider: Record<ProviderId, string> = {
  openrouter: "anthropic/claude-sonnet-5.5",
  deepseek: "deepseek-v4-pro",
  opencode: "deepseek-v4.1-flash",
  "opencode-go": "deepseek-v4.1-flash",
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

/** The subset of a pi-ai chat model the picker reads. */
export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  cost: { input: number; output: number };
};

/**
 * No external ranking covers every direct-provider model, so a model absent from the snapshot above
 * gets a tier from its output price per million tokens: S at $10+, A at $3+, B at $1+, C below. The
 * curated lists use it only where the snapshot is silent; it orders the picker, nothing more.
 */
function costTier(output: number): string {
  if (output >= 10) return "S";
  if (output >= 3) return "A";
  if (output >= 1) return "B";
  return "C";
}

/** A model from a direct provider's own catalog, in the shape the UI renders. */
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
