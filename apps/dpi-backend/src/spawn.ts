// Creating a session is the device's ability, not a feature's: a tool that wants a session asks the device for this
// function and gets exactly one session per key.
import type { SessionSummary, ThinkingLevel } from "../../dpi-sdk/src/api.js";

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;
