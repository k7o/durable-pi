// The job catalogue: JOB_DEFS in its fixed order, one module per job, the handler map the runtime dispatches into,
// and the input validation the tools and the HTTP route share. The order is contract: run records and the
// demo.job-runs document store job and phase ids, the contract test pins both, and a reorder is a prompt change.
import { JobDef } from "../../../../../dpi-sdk/src/api.js";
import { changeWatch } from "./change-watch.js";
import { releaseCheck } from "./release-check.js";
import { todoDigest } from "./todo-digest.js";
import type { Handler, JobModule, Values } from "./types.js";
import { workspaceSnapshot } from "./workspace-snapshot.js";

const MODULES: readonly JobModule[] = [workspaceSnapshot, releaseCheck, changeWatch, todoDigest];

export const JOB_DEFS: JobDef[] = MODULES.map((module) => module.def);

export const jobDef = (id: string) => JOB_DEFS.find((d) => d.id === id);

/** Phase handlers by job id: the engine looks up `HANDLERS[def.id][phase.id]` when a phase starts. */
export const HANDLERS: Readonly<Record<string, Readonly<Record<string, Handler>>>> = Object.fromEntries(
  MODULES.map((module) => [module.def.id, module.handlers]),
);

/** Validate a job's input against its spec, filling defaults. Throws a message the caller can show as is. */
export function resolveJobInput(def: JobDef, raw: unknown): Values {
  const given = (raw ?? {}) as Record<string, unknown>;
  if (typeof given !== "object" || Array.isArray(given)) throw Error("input must be an object");
  const unknown = Object.keys(given).filter((k) => !def.inputs.some((i) => i.name === k));
  if (unknown.length)
    throw Error(`${def.id} has no input ${unknown.join(", ")}. Inputs: ${def.inputs.map((i) => i.name).join(", ") || "none"}`);
  const out: Values = {};
  for (const spec of def.inputs) {
    const value = given[spec.name] ?? spec.default;
    if (spec.type === "integer") {
      const n = typeof value === "string" && value.trim() ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n)) throw Error(`${spec.name} must be an integer`);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max))
        throw Error(`${spec.name} must be ${spec.min} to ${spec.max}`);
      out[spec.name] = n;
    } else {
      if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw Error(`${spec.name} must be a non-empty string`);
      out[spec.name] = value.trim();
    }
  }
  return out;
}
