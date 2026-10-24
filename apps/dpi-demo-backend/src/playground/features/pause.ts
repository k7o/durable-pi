/**
 * A plain wall-clock wait inside one tool call, for the cosmetic pacing of a live transcript. Not the harness's
 * durable `sleep`: nothing here is meant to survive a restart or be replayed, so it must not be recorded.
 */
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
