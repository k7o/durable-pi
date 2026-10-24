// The approval task. A person's decision is its own durable task, waiting on the run's record, so a restart
// resumes the wait instead of losing the request.
import { defineTask } from "@earendil-works/pi-durable";
import { JobRuns } from "./record.js";

export const Approval = defineTask<{ runId: number }, { phase: "wait" }, { approved: boolean }>({
  name: "demo.job-approval",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    // Looks at the run's decision, then parks until the next look without writing; the button click is the only write.
    wait: async (task, runtime, ctx) => {
      const doc = await runtime.snapshot(JobRuns, task.conversationId, ctx);
      const decision = doc?.items[String(task.input.runId)]?.approval;
      if (decision && decision !== "pending") {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: { approved: decision === "approved" } } }),
          ctx,
        );
        return;
      }
      await runtime.sleepUntil(runtime.now() + 500, task.state.checkpoint, ctx);
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});
