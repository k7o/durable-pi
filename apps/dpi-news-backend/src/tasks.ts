// This app's durable tasks, built together because the tool starts both and a session registers both.
//
// One factory so there is one place that knows what a news device can run, and so a test builds exactly what the pack
// registers: the engine matches a started task to a registered definition, and handing it a different object is how a
// slice quietly stops testing the thing that runs.
import type { AppStateStore } from "../../dpi-backend/src/pack-api.js";
import type { StorySource } from "../../dpi-sdk/src/packs/news.js";
import { createNewsDigest } from "./digest.js";
import { createNewsFetch } from "./fetch.js";

export type NewsTasks = {
  digest: ReturnType<typeof createNewsDigest>;
  fetch: ReturnType<typeof createNewsFetch>;
};

/** `sources` is what a fetch run reads when the run itself names none: the pack's list, or a test's local server. */
export function createNewsTasks(appState: AppStateStore, sources?: readonly StorySource[]): NewsTasks {
  return { digest: createNewsDigest(appState), fetch: createNewsFetch(sources) };
}
