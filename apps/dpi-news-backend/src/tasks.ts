// This app's durable tasks, built together because the tool starts both and a session registers both.
//
// One factory so there is one place that knows what a news device can run, and so a test builds exactly what the pack
// registers: the engine matches a started task to a registered definition, and handing it a different object is how a
// slice quietly stops testing the thing that runs.
import type { AppStateStore, Classify } from "../../dpi-backend/src/pack-api.js";
import type { StorySource } from "../../dpi-sdk/src/packs/news.js";
import { createNewsDigest } from "./digest.js";
import { createNewsFetch } from "./fetch.js";
import { createNewsTriage } from "./triage.js";

export type NewsTasks = {
  digest: ReturnType<typeof createNewsDigest>;
  fetch: ReturnType<typeof createNewsFetch>;
  triage: ReturnType<typeof createNewsTriage>;
};

export type NewsOptions = {
  /** What a fetch run reads when the run itself names none: the pack's list, or a test's local server. */
  sources?: readonly StorySource[];
  /** The device's classifier. Absent when the device has none, which a triage run records rather than works around. */
  classify?: Classify;
};

export function createNewsTasks(appState: AppStateStore, options: NewsOptions = {}): NewsTasks {
  return {
    digest: createNewsDigest(appState),
    fetch: createNewsFetch(options.sources),
    triage: createNewsTriage(options.classify),
  };
}
