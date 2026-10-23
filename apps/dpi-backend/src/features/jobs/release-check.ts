// Plan, gather with a subagent, wait for a person's approval, publish and verify.
import type { JobDef } from "../../../../dpi-sdk/src/jobs.js";
import { RESULT_ROOT, clip } from "./shared.js";
import type { Handler, JobModule } from "./types.js";

const def: JobDef = {
  id: "release-check",
  title: "Release check",
  summary:
    "Plan a release review, let a subagent gather facts with read and bash, wait for your approval, then publish the notes to App State and verify them.",
  phases: [
    { id: "plan", label: "Plan", summary: "Decide what the release notes must cover" },
    { id: "gather", label: "Gather", summary: "A subagent runs git and reads the README" },
    { id: "approve", label: "Approve", summary: "Wait for a person to approve publishing", kind: "approval" },
    { id: "publish", label: "Publish", summary: "Write the release notes to App State" },
    { id: "verify", label: "Verify", summary: "Read the notes back and confirm this run published them" },
  ],
  inputs: [
    { name: "commits", type: "integer", default: 5, min: 1, max: 20, description: "How many recent commits the subagent reviews" },
  ],
  approval: true,
  resultPath: `/${RESULT_ROOT}/release-check`,
  seconds: 20,
};

const handlers: Record<string, Handler> = {
    plan: async (p) => {
      const checks = [`Last ${p.input.commits} commits`, "Uncommitted changes", "README headline"];
      for (const [i, check] of checks.entries()) await p.note(`Check ${i + 1}: ${check}`);
      return { done: `${checks.length} checks planned`, data: { checks } };
    },
    gather: async (p) => {
      const notes = await p.agent(
        `Release check: gather facts for run #${p.run.n}. Use bash to run \`git log --oneline -${p.input.commits}\` and \`git status --short\`, then read the first 30 lines of README.md if it exists. Reply with at most 5 short lines: what changed recently, what is uncommitted, and the README headline. Do not edit files.`,
      );
      return { done: clip(notes.split("\n").find((l) => l.trim()) ?? "Gathered", 120), data: { notes } };
    },
    approve: async () => {
      throw Error("approval phases run in the engine");
    },
    publish: async (p) => {
      await p.saveState(`/${RESULT_ROOT}/release-check`, {
        run: p.run.n,
        at: new Date(p.now()).toISOString(),
        checks: p.data.checks ?? [],
        notes: p.data.notes ?? "",
        approved: true,
      });
      return { done: `Published to App State /${RESULT_ROOT}/release-check` };
    },
    verify: async (p) => {
      const saved = (await p.readState(`/${RESULT_ROOT}/release-check`)) as { run?: number; notes?: string } | undefined;
      await p.step("state", `read_state /${RESULT_ROOT}/release-check`, async () => {
        if (saved?.run !== p.run.n) throw Error(`App State holds run #${saved?.run ?? "none"}, not run #${p.run.n}.`);
        return { value: undefined, detail: `run #${saved.run}, ${saved.notes?.length ?? 0} characters of notes` };
      });
      return { done: `Release notes for run #${p.run.n} are live` };
    },
};

export const releaseCheck: JobModule = { def, handlers };
