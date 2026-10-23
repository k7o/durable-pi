// Custom harness extensions an agent can turn on and off. Each is a plain pi-durable extension in the registry; the
// agent's stored selection (`configure({ extensions: { add | remove } })`) decides whether it runs, from the next
// request on. Neither is selected by default.
//
//   system-prompts       a checklist of built-in system prompts, rendered as one section
//   jev-damage-control   Jev judges every bash command before it runs and blocks destructive ones
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, hook, section, ToolTask, type Conversation, type Extension } from "@earendil-works/pi-durable";
import type { AgentExtensions as AgentExtensionsInfo, HarnessExtensionInfo } from "../../dpi-sdk/src/api.js";
import type { SessionRow } from "./catalog.js";
import type { ChangeFeed } from "./changes.js";
import { invalid } from "./errors.js";
import { askJev, type JevAnswer, type JevQuestion } from "./jev.js";
import type { SessionRuntime } from "./session-runtime.js";

const PROMPTS_DIR = join(import.meta.dirname, "../prompts");

export const PROMPTS = [
  {
    id: "smart_ass_opus_fix.md",
    title: "Smart Ass Opus fix",
    description: "Clear, concise, actionable communication: the most important point last, no filler, reference codes.",
  },
  {
    id: "one_sentence.md",
    title: "One sentence",
    description: "Replies in one sentence unless you ask for more. Easy to see turn on and off.",
  },
].map((p) => ({ ...p, text: readFileSync(join(PROMPTS_DIR, p.id), "utf8").trim() }));

/** Which built-in prompts this agent's system-prompts extension renders. */
export const PromptChecklist = defineDoc<{ enabled: string[] }>({
  kind: "ext.system-prompts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ enabled: [PROMPTS[0].id] }),
});

// ------------------------------------------------------------------ jev-damage-control

/** The jev-bash gate's questions and thresholds (harness/extensions/jev-bash/bash-gate.ts). */
const BASH_QUESTIONS: Record<string, JevQuestion> = {
  effect: {
    type: "choice",
    instructions: "What does running `command` do to the machine?",
    criteria: {
      read_only: "Lists, reads, searches, tests, builds into a scratch directory; nothing durable changes",
      reversible: "Changes files or state that git or a reinstall can restore: edits, installs, generated output",
      irreversible:
        "Deletes or overwrites things with no way back: removing directories, force pushing, dropping data, rewriting history",
    },
  },
  destructive_intent: {
    type: "noul",
    instructions: "Does `command` aim to remove or wipe something rather than build or inspect?",
    criteria: {
      true: "rm -rf, drop, purge, force, reset --hard, truncate, overwriting real data",
      false: "Reading, listing, testing, installing, generating, or editing in place",
    },
  },
};

type Verdict = { block: boolean; reason: string };

function gate(a: Record<string, JevAnswer>): Verdict {
  const effect = a.effect as Extract<JevAnswer, { type: "choice" }>;
  const destructive = (a.destructive_intent as Extract<JevAnswer, { type: "noul" }>).noul;
  if (effect.choice === "irreversible" && effect.confidence >= 0.6)
    return { block: true, reason: `irreversible (${effect.confidence.toFixed(2)}): nothing would restore what this removes or overwrites` };
  if (destructive >= 0.7)
    return { block: true, reason: `destructive intent (${destructive.toFixed(2)}): this command aims to wipe something` };
  return { block: false, reason: `${effect.choice} (${effect.confidence.toFixed(2)}), destructive ${destructive.toFixed(2)}` };
}

/** The faux provider's stand-in for Jev, so tests and offline demos never call the network. */
const OFFLINE_DANGER = /\brm\s+-[a-z]*[rf]|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bdropdb\b|\bmkfs|\bdd\s+.*of=|\btruncate\b/;
async function judgeOffline(command: string): Promise<Verdict> {
  return OFFLINE_DANGER.test(command)
    ? { block: true, reason: "destructive intent (offline rules): this command aims to wipe something" }
    : { block: false, reason: "allowed (offline rules)" };
}

// ------------------------------------------------------------------ the extensions

export const ADDON_INFO: Omit<HarnessExtensionInfo, "enabled" | "prompts">[] = [
  {
    name: "system-prompts",
    title: "System prompts",
    description: "Adds the checked prompts to this agent's system prompt. A change applies from the next request.",
  },
  {
    name: "jev-damage-control",
    title: "Jev damage control",
    description:
      "Before every bash call, Jev judges the command in about 300 ms and blocks irreversible or destructive ones. The decision is a durable memo, so a restart never re-asks. If Jev is down, commands run.",
  },
];

export function createAddons(opts: { offline: boolean }) {
  const prompts = defineExtension({
    name: "system-prompts",
    sections: [
      section(
        "system-prompts",
        async (input, ctx) => {
          const checklist = await input.read.snapshot(PromptChecklist, input.conversationId, ctx);
          const enabled = checklist?.enabled ?? [PROMPTS[0].id];
          const text = PROMPTS.filter((p) => enabled.includes(p.id)).map((p) => p.text);
          return text.length ? text.join("\n\n") : undefined;
        },
        { tag: false },
      ),
    ],
  });
  const judge = opts.offline ? judgeOffline : async (command: string) => gate(await askJev({ command }, BASH_QUESTIONS));
  const jev = defineExtension({
    name: "jev-damage-control",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (call.name !== "bash") return;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          let verdict = await api.memo<Verdict>("jev-damage-control", ctx);
          if (!verdict) {
            try {
              verdict = await api.memo<Verdict>("jev-damage-control", await judge(command), ctx);
            } catch {
              return; // Fails open: a Jev outage must not stop bash.
            }
          }
          if (verdict.block) return { block: `jev-damage-control blocked this command: ${verdict.reason}` };
        },
      }),
    ],
  });
  const all: Record<string, Extension> = { "system-prompts": prompts, "jev-damage-control": jev };
  return { all, list: [prompts, jev] };
}

export type Addons = ReturnType<typeof createAddons>;

/**
 * The custom extensions an agent has selected: the installed addons, their defaults, and the
 * system-prompt checklist stored on the conversation. Edits configure the agent's selection.
 */
export class ExtensionSelection {
  constructor(
    private readonly sessions: SessionRuntime,
    private readonly changes: ChangeFeed,
  ) {}

  async of(row: SessionRow, c: Conversation): Promise<AgentExtensionsInfo> {
    const active = new Set((await c.agent(ctx)).extensions.map((e) => e.name));
    const checked = (await this.sessions.harness(row).snapshot(PromptChecklist, c.id, ctx))?.enabled ?? [PROMPTS[0].id];
    return {
      builtIn: [...active].filter((name) => !ADDON_INFO.some((a) => a.name === name)),
      extensions: ADDON_INFO.map((info) => ({
        ...info,
        enabled: active.has(info.name),
        ...(info.name === "system-prompts"
          ? { prompts: PROMPTS.map(({ id, title, description, text }) => ({ id, title, description, text, enabled: checked.includes(id) })) }
          : {}),
      })),
    };
  }

  /** `{name, enabled}` edits the agent's extension selection; `{prompt, enabled}` edits its prompt checklist. */
  async set(row: SessionRow, c: Conversation, body: Record<string, unknown>): Promise<AgentExtensionsInfo> {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    const enabled = body.enabled;
    if (typeof body.name === "string") {
      const extension = this.sessions.addons(row).all[body.name];
      if (!extension) throw invalid(`Unknown extension ${body.name}. Known: ${ADDON_INFO.map((a) => a.name).join(", ")}`);
      // An array is the agent's whole selection. An { add | remove } object would edit the host default instead and
      // replace the previous edit, so turning one extension on would turn the other off.
      const rank = (name: string) => ADDON_INFO.findIndex((a) => a.name === name);
      const others = (await c.agent(ctx)).extensions.filter((e) => e.name !== extension.name);
      const next = (enabled ? [...others, extension] : others).sort((a, b) => rank(a.name) - rank(b.name));
      await c.configure({ extensions: next }, ctx);
    } else if (typeof body.prompt === "string") {
      const prompt = body.prompt;
      if (!PROMPTS.some((p) => p.id === prompt)) throw invalid(`Unknown prompt ${prompt}. Known: ${PROMPTS.map((p) => p.id).join(", ")}`);
      await c.commit(async (tx) => {
        const doc = await tx.doc(PromptChecklist, c.id);
        const next = new Set(doc.enabled);
        if (enabled) next.add(prompt);
        else next.delete(prompt);
        doc.enabled = PROMPTS.map((p) => p.id).filter((id) => next.has(id));
      }, ctx);
    } else throw invalid("name or prompt is required");
    this.changes.notify();
    return this.of(row, c);
  }
}
