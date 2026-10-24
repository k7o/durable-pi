// The playground's own endpoints: write the shared App State, start a durable job for a
// conversation, and answer a run's approval. They join the shared state, the job registry and the
// device, so they sit above those modules rather than inside one of them. The demo pack's routes call
// these; its tests call them directly.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import type { StateChange } from "../../../dpi-sdk/src/app-state.js";
import type { Device } from "../device.js";
import { ApiFault, invalid } from "../errors.js";
import { JOB_DEFS, jobDef, resolveJobInput } from "./features/jobs/defs.js";
import type { Jobs } from "./features/jobs/engine.js";
import { JobRuns } from "./features/jobs/record.js";
import { APP_STATE_DOC, type SharedState } from "./shared-state.js";

export class Playground {
  constructor(
    private readonly shared: () => SharedState,
    private readonly jobsOf: (sessionId: string) => Jobs | undefined,
  ) {}

  async demoState(device: Device, c: Conversation, body: Record<string, unknown>) {
    let change = body as unknown as StateChange;
    if (body.operation === undefined) {
      const { value } = await this.shared().snapshot();
      if (typeof body.goal === "string")
        change = { operation: Object.hasOwn(value, "goal") ? "update" : "create", path: "/goal", value: body.goal };
      else if (body.increment === true) change = { operation: "increment", path: "/counter", value: 1 };
      else if (typeof body.note === "string") change = { operation: "create", path: "/notes/-", value: body.note };
      else throw invalid("A state operation is required");
    }
    await this.shared().change(
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
    return { ok: true as const, ...(await device.documents.deviceDoc(APP_STATE_DOC)) };
  }

  /** Start a durable job from a client: the conversation owns the run, and a transcript entry anchors its card. */
  async startJob(device: Device, sessionId: string, c: Conversation, body: Record<string, unknown>) {
    const jobs = device.isOpen(sessionId) ? this.jobsOf(sessionId) : undefined;
    if (!jobs) throw new ApiFault("unavailable", "Session is not open");
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
    device.harness(device.row(sessionId)).resume();
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
