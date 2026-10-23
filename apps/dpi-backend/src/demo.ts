// The playground's own endpoints: write the shared App State, start a durable job for a
// conversation, and answer a run's approval. They join the document store, the job registry and the
// session runtime, so they sit above those modules rather than inside one of them.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { StateChange } from "../../dpi-sdk/src/app-state.js";
import type { SessionRow } from "./catalog.js";
import type { Documents } from "./documents.js";
import { ApiFault, invalid } from "./errors.js";
import { JOB_DEFS, jobDef, resolveJobInput } from "./features/jobs/defs.js";
import type { Jobs } from "./features/jobs/engine.js";
import { JobRuns } from "./features/jobs/record.js";
import type { SharedState } from "./shared-state.js";

export class Playground {
  constructor(
    private readonly shared: SharedState,
    private readonly documents: Documents,
  ) {}

  async demoState(c: Conversation, body: Record<string, unknown>) {
    let change = body as unknown as StateChange;
    if (body.operation === undefined) {
      const { value } = await this.shared.snapshot();
      if (typeof body.goal === "string")
        change = { operation: Object.hasOwn(value, "goal") ? "update" : "create", path: "/goal", value: body.goal };
      else if (body.increment === true) change = { operation: "increment", path: "/counter", value: 1 };
      else if (typeof body.note === "string") change = { operation: "create", path: "/notes/-", value: body.note };
      else throw invalid("A state operation is required");
    }
    await this.shared.change(
      change,
      undefined,
      typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
    );
    await c.commit(
      (tx) =>
        tx.appendEntry(c.id, {
          kind: "demo.state-change",
          data: { text: `Shared App State: ${change.operation} ${change.path || "/"}` },
        }),
      ctx,
    );
    return { ok: true as const, ...(await this.documents.deviceDoc("app.shared-state")) };
  }

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  async startJob(row: SessionRow, h: Harness, c: Conversation, jobs: Jobs, body: Record<string, unknown>) {
    const def = typeof body.job === "string" ? jobDef(body.job) : undefined;
    if (!def) throw invalid(`job must be one of ${JOB_DEFS.map((d) => d.id).join(", ")}`);
    let input;
    try {
      input = resolveJobInput(def, body.input ?? {});
    } catch (e) {
      throw invalid((e as Error).message);
    }
    const taskId = await c.commit(async (tx) => {
      const id = await jobs.start(tx, c.id, { def, input, startedBy: "you", now: Date.now() });
      await tx.appendEntry(c.id, { kind: "demo.job", data: { taskId: id as number, job: def.id, text: `Started ${def.title}` } });
      return id;
    }, ctx);
    h.resume();
    return { taskId: taskId as number };
  }

  async approveJob(c: Conversation, taskId: number, approved: unknown) {
    if (typeof approved !== "boolean") throw invalid("approved must be a boolean");
    await c.commit(async (tx) => {
      const run = (await tx.doc(JobRuns, c.id)).items[String(taskId)];
      if (!run || run.approval !== "pending") throw new ApiFault("conflict", "No pending approval for that run");
      run.approval = approved ? "approved" : "declined";
    }, ctx);
    return { ok: true as const };
  }
}
