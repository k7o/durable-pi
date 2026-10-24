// Minimal Jev client (TypeSafe System One), from harness/extensions/jev-bash/core/client.ts: one call answers a few
// bounded questions about a JSON state in a few hundred milliseconds.
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

const RETRY = new Set([429, 502, 503, 529]);

/**
 * TypeSafe serves System One natively; OpenRouter and OpenCode Zen both re-serve it. First
 * configured credential wins, so a device that already had an OpenRouter key keeps using it.
 * `DPI_JEV_MODEL` overrides the model (OpenCode Zen also offers the paid `jev-1.13`).
 */
function jevEndpoint(): [string, string, string] | undefined {
  const model = process.env.DPI_JEV_MODEL;
  if (process.env.TYPESAFE_API_KEY)
    return ["https://api.typesafe.ai/v1/systemone", process.env.TYPESAFE_API_KEY, model ?? "jev-latest"];
  if (process.env.OPENROUTER_API_KEY)
    return ["https://openrouter.ai/api/alpha/decisions", process.env.OPENROUTER_API_KEY, model ?? "~typesafe/jev-latest"];
  if (process.env.OPENCODE_API_KEY)
    return ["https://opencode.ai/inference/v1/systemone", process.env.OPENCODE_API_KEY, model ?? "jev-1.13-free"];
  return undefined;
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, JevAnswer>> {
  const endpoint = jevEndpoint();
  if (!endpoint) throw Error("Jev needs TYPESAFE_API_KEY, OPENROUTER_API_KEY or OPENCODE_API_KEY");
  const [url, key, model] = endpoint;
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (RETRY.has(res.status) && attempt < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw Error(`Jev HTTP ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
    for (const [id, q] of Object.entries(questions))
      if (data.answers?.[id]?.type !== q.type) throw Error(`Jev answer missing: ${id}`);
    return data.answers!;
  }
}
