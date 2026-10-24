// The device's fake model: an echo reply and a slow one. Enough to prove the provider seam and drive a turn; the demo
// app ships the scripted double (jobs, todos, spawning) and that one belongs to the demo, not the device.
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelInfo } from "../../dpi-sdk/src/api.js";
import { Models } from "../src/models.js";

export const faux = { provider: "faux", modelId: "echo" } as const;

const INFO: ModelInfo[] = [
  {
    id: "echo",
    provider: "faux",
    name: "Faux Echo",
    tier: "T",
    icon: "lab.png",
    contextWindow: 128000,
    reasoning: false,
    cost: { input: 0, output: 0 },
  },
];

/** A `Models` whose engine answers locally: the provider seam device tests need, and nothing else. */
export async function fauxModels(): Promise<Models> {
  const engine = createModels();
  installFaux(engine);
  return Models.from({ provider: "faux", engine, models: INFO, defaultModel: faux.modelId });
}

function installFaux(models: MutableModels) {
  const handle = fauxProvider({
    provider: "faux",
    models: [{ id: "echo", name: "Faux Echo", contextWindow: 128000, maxTokens: 8192 }],
    tokensPerSecond: 400,
  });
  const reply: FauxResponseFactory = (context) => {
    handle.appendResponses([reply]);
    const messages = context.messages as unknown as { role: string; content?: unknown }[];
    const textOf = (m?: { content?: unknown }) =>
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? (m!.content as { type: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("")
          : "";
    const prompt = textOf([...messages].reverse().find((m) => m.role === "user")).trim();
    if (prompt.startsWith("slow:")) return fauxAssistantMessage(fauxText(prompt.slice(5).trim().repeat(4)));
    return fauxAssistantMessage(fauxText(`Echo: ${prompt}`));
  };
  handle.setResponses([reply]);
  models.setProvider(handle.provider);
  return handle;
}
