// Baseline a folder, re-check on an interval with one checkpoint per check, then report.
import { JobDef } from "../../../../../dpi-sdk/src/api.js";
import { RESULT_ROOT, clip, inDir, label } from "./shared.js";
import type { Handler, JobModule } from "./types.js";

/** Two levels deep, skipping the repository and dependency trees: enough to see a folder change. */
const FIND = `find . -maxdepth 2 -type f -not -path '*/.git/*' -not -path '*/node_modules/*'`;

/** cksum output as path → "size:crc", so two checks of the same folder compare in one map. */
function checksums(out: string) {
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) map[m[3].replace(/^\.\//, "")] = `${m[1]}:${m[2]}`;
  }
  return map;
}

const def: JobDef = {
  id: "change-watch",
  title: "Change watch",
  summary:
    "Take a baseline of a folder, check it again on a fixed interval with one checkpoint per check, then report what changed. Close the browser or restart the device mid-run; it resumes.",
  phases: [
    { id: "baseline", label: "Baseline", summary: "Checksum every file up to two levels deep" },
    { id: "watch", label: "Watch", summary: "Re-check on an interval, one checkpoint per check", kind: "repeat" },
    { id: "report", label: "Report", summary: "Save what changed to App State" },
  ],
  inputs: [
    { name: "path", type: "string", default: ".", description: "Folder to watch, relative to the agent's working directory" },
    { name: "checks", type: "integer", default: 5, min: 2, max: 20, description: "How many checks the watch phase runs" },
    { name: "interval_seconds", type: "integer", default: 4, min: 2, max: 60, description: "Seconds between checks" },
  ],
  approval: false,
  resultPath: `/${RESULT_ROOT}/change-watch`,
  seconds: 25,
};

const handlers: Record<string, Handler> = {
    baseline: async (p) => {
      const dir = String(p.input.path);
      const sums = await p.step("command", label(dir, "cksum every file (2 levels)"), async () => {
        const r = await p.shell(inDir(dir, `${FIND} -exec cksum {} + 2>/dev/null | head -300`));
        const map = checksums(r.out);
        return { value: map, detail: `${Object.keys(map).length} files` };
      });
      return {
        done: `Baseline of ${Object.keys(sums).length} files`,
        data: { sums, changes: [], nextAt: p.now() + Number(p.input.interval_seconds) * 1000 },
      };
    },
    watch: async (p) => {
      const dir = String(p.input.path);
      const total = Number(p.input.checks);
      const n = p.iteration + 1;
      // Park until the interval is up, then run this same check iteration: no invocation is held in between.
      const nextAt = Number(p.data.nextAt ?? 0);
      if (p.now() < nextAt) return { sleep: nextAt };
      const before = (p.data.sums ?? {}) as Record<string, string>;
      const { sums, found } = await p.step("checkpoint", `Check ${n}/${total}`, async () => {
        const r = await p.shell(inDir(dir, `${FIND} -exec cksum {} + 2>/dev/null | head -300`));
        const now = checksums(r.out);
        const diff = [
          ...Object.keys(now).filter((f) => !(f in before)).map((f) => `+ ${f}`),
          ...Object.keys(before).filter((f) => !(f in now)).map((f) => `- ${f}`),
          ...Object.keys(now).filter((f) => f in before && before[f] !== now[f]).map((f) => `~ ${f}`),
        ];
        return {
          value: { sums: now, found: diff },
          detail: diff.length ? `${diff.length} change${diff.length === 1 ? "" : "s"}: ${clip(diff.join(", "), 200)}` : "No changes. Checkpoint saved.",
        };
      });
      await p.progress(n, total);
      const changes = [...((p.data.changes ?? []) as string[]), ...found].slice(-100);
      if (n < total)
        return { again: { sums, changes, nextAt: p.now() + Number(p.input.interval_seconds) * 1000 } };
      return { done: `${total} checks, ${changes.length} change${changes.length === 1 ? "" : "s"}`, data: { sums: {}, changes } };
    },
    report: async (p) => {
      const changes = (p.data.changes ?? []) as string[];
      await p.saveState(`/${RESULT_ROOT}/change-watch`, {
        run: p.run.n,
        at: new Date(p.now()).toISOString(),
        folder: String(p.input.path),
        checks: Number(p.input.checks),
        changes,
      });
      return { done: changes.length ? `${changes.length} changes saved to App State` : "No changes. Report saved to App State" };
    },
};

export const changeWatch: JobModule = { def, handlers };
