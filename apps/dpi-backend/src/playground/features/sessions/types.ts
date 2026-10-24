// What this backend hands a tool that wants to create a session: a function that creates exactly one session per
// key, so a retried call cannot create two.
import type { SessionSummary, ThinkingLevel } from "../../../../../dpi-sdk/src/api.js";

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;
