// The one real side effect in the playground: paging a person. It has no replay policy, so a crash returns an
// interrupted result instead of paging twice.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { writing } from "../../../../../dpi-backend/src/pack-api.js";
import { TOOL_DESCRIPTIONS } from "../../prompt.js";
import type { Feature } from "../feature.js";
import { pause } from "../pause.js";
import { Pager } from "./pager.js";

  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never pages twice.
  const pingOnCall = defineTool({
    name: "ping_on_call_engineer",
    description: TOOL_DESCRIPTIONS.ping_on_call_engineer,
    parameters: Type.Object({
      summary: Type.String({ description: "What the engineer needs to know, one or two sentences." }),
      severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("critical")])),
    }),
    execute: async (args, api, ctx) => {
      const prior = await api.snapshot(Pager, api.conversationId, ctx);
      if (prior?.paged)
        throw Error(
          `Already paged at ${new Date(prior.at).toISOString()} (${prior.page}). ping_on_call_engineer works once per agent.`,
        );
      const severity = args.severity ?? "high";
      const page = `PG-${String(api.taskId).padStart(4, "0")}`;
      api.output("Dialing the on-call engineer…\n");
      await pause(1500);
      await api.commit(async (tx) => {
        const pager = await tx.doc(Pager, api.conversationId);
        if (pager.paged) throw Error(`Already paged (${pager.page}).`);
        Object.assign(pager, { paged: true, at: Date.now(), page, summary: args.summary.slice(0, 300) });
      }, ctx);
      api.output(`Paged on-call, ${severity} severity: ${page}\nWaiting for acknowledgement…\n`);
      await pause(1500);
      api.output("Acknowledged.\n");
      return {
        output: [
          {
            type: "text",
            text: `Paged the on-call engineer (${page}, ${severity}). They acknowledged. Do not page again for this.`,
          },
        ],
      };
    },
  });

export function pager(): Feature {
  return { tools: [writing(pingOnCall)] };
}
