// The device's model policy: register exactly one provider, curate its picker list, route stored
// choices to this device, and keep the resulting model list. The harness reads `engine`.
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelInfo } from "../../dpi-sdk/src/api.js";
import { invalid } from "./errors.js";
import { curatedByProvider, defaultModelByProvider, describeModel } from "./model-catalog.js";
import { providerFor, type ProviderId } from "./provider.js";

type Engine = ReturnType<typeof createModels>;

export class Models {
  private constructor(
    readonly provider: ProviderId,
    readonly list: ModelInfo[],
    readonly defaultModelId: string,
    readonly engine: Engine,
  ) {}

  /** A provider this build ships: it is registered here, and its picker list is curated. */
  static async open(provider: ProviderId, defaultModel?: string): Promise<Models> {
    if (provider === "faux")
      throw Error("faux is the demo app's model. Run the demo app (`just demo dev`), or set a real DPI_PROVIDER.");
    const engine = createModels();
    const built = providerFor(provider);
    const shortlist = curatedByProvider[provider];
    // A shortlist provider keeps only its reviewed models; the rest list their whole catalog.
    engine.setProvider(
      shortlist
        ? { ...built, getModels: () => built.getModels().filter((m) => shortlist.some((c) => c.id === m.id)) }
        : built,
    );
    return new Models(provider, await listModels(provider, engine), defaultModel ?? defaultModelByProvider[provider], engine);
  }

  /** A provider the caller registered in `engine` and described itself, such as a test double or an offline demo. */
  static from(source: { provider: ProviderId; engine: Engine; models: ModelInfo[]; defaultModel: string }): Models {
    return new Models(source.provider, source.models, source.defaultModel, source.engine);
  }

  /** A stored model from another provider falls back to this device's default. */
  routed(model?: ModelRef): ModelRef {
    const known = model?.provider === this.provider && !!this.engine.getModel(this.provider, model.modelId);
    return { provider: this.provider, modelId: known ? model!.modelId : this.defaultModelId };
  }

  validate(model: unknown): ModelRef {
    const m = model as ModelRef | undefined;
    if (!m || typeof m.provider !== "string" || typeof m.modelId !== "string")
      throw invalid("model must be { provider, modelId }");
    if (m.provider !== this.provider || !this.engine.getModel(m.provider, m.modelId))
      throw invalid(`Unknown model ${m.provider}/${m.modelId}. Choose one from GET /v1/device models`);
    return { provider: m.provider, modelId: m.modelId };
  }

  windowOf(modelId: string): number {
    return this.list.find((m) => m.id === modelId)?.contextWindow ?? 0;
  }
}

async function listModels(provider: ProviderId, engine: Engine): Promise<ModelInfo[]> {
  // Authorization resolves for every provider, so a device without a key lists no models.
  const available = await engine.getAvailable(provider, { signal: AbortSignal.timeout(10000) });
  const shortlist = curatedByProvider[provider];
  if (shortlist)
    return shortlist.flatMap((c) => {
      const m = available.find((entry) => entry.id === c.id);
      return m
        ? [
            {
              id: m.id,
              provider,
              name: c.name,
              tier: c.tier,
              icon: c.icon,
              contextWindow: m.contextWindow,
              reasoning: m.reasoning,
              cost: { input: m.cost.input, output: m.cost.output },
            },
          ]
        : [];
    });
  return available.map((m) => describeModel(provider, m));
}
