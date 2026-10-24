// Snapshot, measure and save one folder. Four fixed phases, no approval, no repeats.
import { JobDef } from "../../../../../dpi-sdk/src/api.js";
import { RESULT_ROOT, inDir, label } from "./shared.js";
import type { Handler, JobModule } from "./types.js";

const def: JobDef = {
  id: "workspace-snapshot",
  title: "Workspace snapshot",
  summary: "Scan a folder, measure it and save a snapshot to App State. The same four phases every run.",
  phases: [
    { id: "scan", label: "Scan", summary: "Read the git branch, changed files and top-level entries" },
    { id: "measure", label: "Measure", summary: "Count files by extension" },
    { id: "save", label: "Save", summary: "Write the snapshot to App State" },
    { id: "verify", label: "Verify", summary: "Read App State back and compare it with this run" },
  ],
  inputs: [
    { name: "path", type: "string", default: ".", description: "Folder to snapshot, relative to the agent's working directory" },
  ],
  approval: false,
  resultPath: `/${RESULT_ROOT}/workspace-snapshot`,
  seconds: 5,
};

const handlers: Record<string, Handler> = {
    scan: async (p) => {
      const dir = String(p.input.path);
      const branch = (
        await p.exec(inDir(dir, `git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(not a git repo)"`), label(dir, "git rev-parse --abbrev-ref HEAD"))
      ).trim();
      const changed = (await p.exec(inDir(dir, "git status --short 2>/dev/null | head -50"), label(dir, "git status --short")))
        .split("\n")
        .filter(Boolean).length;
      const entries = (await p.exec(inDir(dir, "ls -1A | head -200"), label(dir, "ls -1A"))).split("\n").filter(Boolean).length;
      return { done: `${branch}, ${changed} changed, ${entries} entries`, data: { branch, changed, entries } };
    },
    measure: async (p) => {
      const dir = String(p.input.path);
      const count = Number(
        (await p.exec(inDir(dir, `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | wc -l`), label(dir, "find . -type f | wc -l"))).trim(),
      );
      const raw = await p.exec(
        inDir(
          dir,
          `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sed -n 's/.*\\/[^/]*\\.\\([A-Za-z0-9]\\{1,8\\}\\)$/\\1/p' | sort | uniq -c | sort -rn | head -6`,
        ),
        label(dir, "count files by extension"),
      );
      const top = raw
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 2)
        .map(([n, ext]) => ({ ext, count: Number(n) }));
      return {
        done: `${count} files${top.length ? `: ${top.map((t) => `${t.ext} ${t.count}`).join(", ")}` : ""}`,
        data: { files: count, top },
      };
    },
    save: async (p) => {
      await p.saveState(`/${RESULT_ROOT}/workspace-snapshot`, {
        run: p.run.n,
        at: new Date(p.now()).toISOString(),
        folder: String(p.input.path),
        branch: p.data.branch ?? null,
        changed: p.data.changed ?? 0,
        entries: p.data.entries ?? 0,
        files: p.data.files ?? 0,
        top: p.data.top ?? [],
      });
      return { done: `Saved to App State /${RESULT_ROOT}/workspace-snapshot` };
    },
    verify: async (p) => {
      const saved = (await p.readState(`/${RESULT_ROOT}/workspace-snapshot`)) as { run?: number; files?: number } | undefined;
      await p.step("state", `read_state /${RESULT_ROOT}/workspace-snapshot`, async () => {
        if (saved?.run !== p.run.n || saved.files !== p.data.files)
          throw Error(`App State holds run #${saved?.run ?? "none"}, not run #${p.run.n}. Another writer changed it.`);
        return { value: undefined, detail: `run #${saved.run}, ${saved.files} files` };
      });
      return { done: `App State matches run #${p.run.n}` };
    },
};

export const workspaceSnapshot: JobModule = { def, handlers };
