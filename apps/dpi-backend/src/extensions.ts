// Which custom extensions an agent has selected: the pack's addons, their defaults, and the prompt checklist the pack
// stores. The device owns this read/write path; only the list of addons and their prompt handling come from the pack.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { AgentExtensions } from "../../dpi-sdk/src/api.js";
import type { SessionRow } from "./catalog.js";
import type { ChangeFeed } from "./changes.js";
import { invalid } from "./errors.js";
import type { PackExtensions } from "./pack.js";
import type { SessionRuntime } from "./session-runtime.js";

export class ExtensionSelection {
  constructor(
    private readonly sessions: SessionRuntime,
    private readonly changes: ChangeFeed,
    private readonly pack?: PackExtensions,
  ) {}

  async of(row: SessionRow, c: Conversation): Promise<AgentExtensions> {
    const addons = this.pack?.list ?? [];
    const active = new Set((await c.agent(ctx)).extensions.map((e) => e.name));
    const checked = this.pack ? await this.pack.prompts(this.sessions.harness(row), c.id) : [];
    return {
      builtIn: [...active].filter((name) => !addons.some((a) => a.name === name)),
      extensions: addons.map((addon) => ({
        name: addon.name,
        title: addon.title,
        description: addon.description,
        enabled: active.has(addon.name),
        ...(addon.prompts
          ? {
              prompts: addon.prompts.map(({ id, title, description, text }) => ({
                id,
                title,
                description,
                text,
                enabled: checked.includes(id),
              })),
            }
          : {}),
      })),
    };
  }

  /** `{name, enabled}` edits the agent's extension selection; `{prompt, enabled}` edits its prompt checklist. */
  async set(row: SessionRow, c: Conversation, body: Record<string, unknown>): Promise<AgentExtensions> {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const addons = this.pack?.list ?? [];
    if (typeof body.name === "string") {
      const addon = addons.find((a) => a.name === body.name);
      if (!addon)
        throw invalid(`Unknown extension ${body.name}. Known: ${addons.map((a) => a.name).join(", ") || "none"}`);
      // An array is the agent's whole selection. An { add | remove } object would edit the host default instead and
      // replace the previous edit, so turning one extension on would turn the other off.
      const rank = (name: string) => addons.findIndex((a) => a.name === name);
      const others = (await c.agent(ctx)).extensions.filter((e) => e.name !== addon.name);
      const next = (body.enabled ? [...others, addon.extension] : others).sort((a, b) => rank(a.name) - rank(b.name));
      await c.configure({ extensions: next }, ctx);
    } else if (typeof body.prompt === "string" && this.pack) {
      await this.pack.setPrompt(c, body.prompt, body.enabled);
    } else throw invalid("name or prompt is required");
    this.changes.notify();
    return this.of(row, c);
  }
}
