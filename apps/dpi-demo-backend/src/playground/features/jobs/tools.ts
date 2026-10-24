// The job tools: list the catalogue, start a run, check one. The run report is compact enough for a model and
// complete enough to act on; progress lines are the live output of a call that waits for its run.
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { jobRunDone, type JobRun } from "../../../../../dpi-sdk/src/jobs.js";
import { TOOL_DESCRIPTIONS } from "../../prompt.js";
import { writing } from "../../../../../dpi-backend/src/tool-policy.js";
import type { Feature } from "../feature.js";
import { pause } from "../pause.js";
import { Receipt } from "../receipt.js";
import { jobDef, resolveJobInput } from "./defs.js";
import type { Jobs } from "./engine.js";
import { JobRuns } from "./record.js";
import { clip } from "./shared.js";

/** One line per phase change, for the run_durable_job call's live output. */
function progressLines(run: JobRun) {
  return run.phases.flatMap((phase, i) => {
    const n = `${i + 1}/${run.phases.length} ${phase.label}`;
    if (phase.status === "done") return [`✓ ${n}: ${phase.summary ?? "done"}`];
    if (phase.status === "running") return [`▸ ${n}`];
    if (phase.status === "waiting") return [`⏸ ${n}: waiting for a person to approve in the chat`];
    if (phase.status === "failed" || phase.status === "aborted") return [`✗ ${n}: ${phase.summary ?? phase.status}`];
    return [];
  });
}

const phaseLabel = (run: JobRun) => run.phases.find((p) => p.id === run.phase)?.label;


/** One run as check_durable_job reports it: compact enough for a model, complete enough to act on. */
function runReport(run: JobRun, now: number) {
  return {
    taskId: run.id,
    job: run.job,
    title: run.title,
    run: run.run,
    status: run.status,
    ...(jobRunDone(run) ? {} : { phase: phaseLabel(run) }),
    ...(run.approval === "pending" ? { next: "Waiting for a person to approve in the chat" } : {}),
    ...(run.approval && run.approval !== "pending" ? { approval: run.approval } : {}),
    startedBy: run.startedBy,
    background: run.background,
    seconds: Math.round(((run.endedAt ?? now) - run.startedAt) / 100) / 10,
    ...(run.resumed ? { resumedAfterRestart: run.resumed } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    phases: run.phases.map((p) => ({
      phase: p.label,
      status: p.status,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.progress ? { progress: `${p.progress.done}/${p.progress.total}` } : {}),
      ...(p.steps.length
        ? { steps: p.steps.map((s) => `${s.status} ${s.kind} ${s.label}${s.detail ? `: ${clip(s.detail.replace(/\s+/g, " "), 160)}` : ""}`) }
        : {}),
    })),
  };
}

export function jobsTools(jobs: Jobs): Feature {
  const recentRuns = async (api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) =>
    Object.values((await api.snapshot(JobRuns, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
  const listJobs = defineTool({
    name: "list_durable_jobs",
    description: TOOL_DESCRIPTIONS.list_durable_jobs,
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify(
              jobs.defs.map((d) => ({
                job: d.id,
                title: d.title,
                summary: d.summary,
                phases: d.phases.map((p) => `${p.label}: ${p.summary}`),
                inputs: Object.fromEntries(
                  d.inputs.map((i) => [
                    i.name,
                    { type: i.type, default: i.default, ...(i.min !== undefined ? { min: i.min, max: i.max } : {}), description: i.description },
                  ]),
                ),
                needsApproval: d.approval,
                savesTo: d.resultPath,
                typicalSeconds: d.seconds,
                recentRuns: runs
                  .filter((r) => r.job === d.id)
                  .slice(0, 5)
                  .map((r) => ({ taskId: r.id, run: r.run, status: r.status, phase: phaseLabel(r) })),
              })),
            ),
          },
        ],
      };
    },
  });
  const runJob = defineTool({
    name: "run_durable_job",
    description: TOOL_DESCRIPTIONS.run_durable_job,
    parameters: Type.Object({
      job: Type.String({ description: "Job id from list_durable_jobs." }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description: "The job's inputs by name. Omitted inputs use their defaults.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the run to finish, including any approval. Default false." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const def = jobDef(args.job);
      if (!def) throw Error(`Unknown job ${args.job}. Jobs: ${jobs.defs.map((d) => d.id).join(", ")}`);
      const input = resolveJobInput(def, args.input ?? {});
      const wait = args.wait === true;
      // A replay after a crash finds the run this call started instead of starting another.
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return Number(receipt.result);
        const id = await jobs.start(tx, api.conversationId, {
          def,
          input,
          startedBy: "agent",
          toolCallId: api.callId,
          ...(wait ? { owner: api.taskId } : {}),
          now: Date.now(),
        });
        receipt.applied = true;
        receipt.result = String(id);
        return id as number;
      }, ctx);
      await api.details({ taskId, job: def.id }, ctx);
      const read = async () => (await api.snapshot(JobRuns, api.conversationId, ctx))?.items[String(taskId)];
      if (!wait) {
        const run = await read();
        return {
          output: [
            {
              type: "text",
              text: `Started ${def.title} run #${run?.run ?? "?"} as durable task #${taskId}. It runs in the background, shows live in the chat and saves its result to App State ${def.resultPath}. Check it with check_durable_job {"task_id":${taskId}}.`,
            },
          ],
          details: { taskId, job: def.id },
        };
      }
      const printed = new Set<string>();
      let run = await read();
      for (;;) {
        for (const line of run ? progressLines(run) : [])
          if (!printed.has(line)) {
            printed.add(line);
            api.output(`${line}\n`);
          }
        if (!run || jobRunDone(run)) break;
        await pause(400);
        run = await read();
      }
      const ok = run?.status === "completed";
      return {
        output: [
          {
            type: "text",
            text: run
              ? `${def.title} run #${run.run} ${run.status}${ok ? `: ${run.result}` : run.error ? `: ${run.error}` : ""}.\n${progressLines(run).join("\n")}${ok ? `\nResult saved to App State ${def.resultPath}.` : ""}`
              : `${def.title} task #${taskId} has no record.`,
          },
        ],
        isError: !ok,
        details: { taskId, job: def.id },
      };
    },
  });
  const checkJob = defineTool({
    name: "check_durable_job",
    description: TOOL_DESCRIPTIONS.check_durable_job,
    parameters: Type.Object({
      task_id: Type.Optional(Type.Integer({ minimum: 1, description: "The run's task id." })),
      job: Type.Optional(Type.String({ description: "A job id: check its latest run." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      const run =
        args.task_id !== undefined
          ? runs.find((r) => r.id === args.task_id)
          : args.job !== undefined
            ? runs.find((r) => r.job === args.job)
            : undefined;
      if (args.task_id === undefined && args.job === undefined)
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify(
                runs.slice(0, 10).map((r) => ({ taskId: r.id, job: r.job, run: r.run, status: r.status, phase: phaseLabel(r) })),
              ),
            },
          ],
        };
      if (!run)
        throw Error(
          `No run ${args.task_id !== undefined ? `with task id ${args.task_id}` : `of ${args.job}`} in this conversation. Runs: ${runs.map((r) => `${r.id} (${r.job} #${r.run})`).join(", ") || "none"}`,
        );
      return { output: [{ type: "text", text: JSON.stringify(runReport(run, Date.now())) }] };
    },
  });

  return { tasks: jobs.tasks, tools: [listJobs, writing(runJob), checkJob] };
}
