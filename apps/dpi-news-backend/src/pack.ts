// The news desk pack: the device's one seam. Everything this app is lives here — one conversation document, one tool,
// two tasks — and nothing in apps/dpi-backend changes to run it. Load it by path (`DPI_PACK=/…/src/pack.ts`) or pass
// `createNewsPack()` from this app's own entrypoint (`src/main.ts`).
//
// The task takes the device's App State store, which the device opens and hands to `createSession`, so this app records
// its last run in the same shared document the demo does without importing the demo.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  DEVICE_CAPABILITIES,
  writing,
  type AppStateStore,
  type ConversationDoc,
  type DevicePack,
} from "../../dpi-backend/src/pack-api.js";
import { STORIES_DOC, type StoriesDoc, type StorySource } from "../../dpi-sdk/src/packs/news.js";
import { Stories } from "./stories.js";
import { createNewsTasks } from "./tasks.js";
import { createNewsTool } from "./tool.js";

/** What a client may assume this device serves, on top of what every device does. */
export const NEWS_CAPABILITY = "news";

const EMPTY: StoriesDoc = { items: [], runs: 0 };

/**
 * The news document. Seeding order is one entry, but the rule still holds: a document is registered and seeded from
 * this list, so it cannot be served at `GET .../docs/:kind` without also existing in a new conversation.
 */
const docs: readonly ConversationDoc[] = [
  {
    kind: STORIES_DOC,
    empty: EMPTY,
    seed: (tx, conversationId) => tx.doc(Stories, conversationId),
    read: (h, conversationId) => h.snapshot(Stories, conversationId, ctx),
  },
];

/**
 * One extension, so the whole app is one line in a session's tool list. The tool closes over the same task definitions the
 * session registers, which is what makes `fetch` and `digest` start the tasks that actually run.
 */
export function newsExtension(appState: AppStateStore, sources?: readonly StorySource[]) {
  const tasks = createNewsTasks(appState, sources);
  return defineExtension({
    name: "news",
    tools: [writing(createNewsTool(tasks))],
    tasks: [tasks.fetch, tasks.digest],
  });
}

/**
 * `sources` is what a fetch run reads; the default is `DEFAULT_SOURCES`. A test passes its own local server, which is the
 * only way to exercise the run without the news. It belongs here rather than on the started task because the engine runs
 * the definition the session registered, not the object the tool happened to hand `createTask`.
 */
export function createNewsPack(sources?: readonly StorySource[]): DevicePack {
  return {
    name: "news",
    docs,
    info: () => ({ capabilities: [...DEVICE_CAPABILITIES, NEWS_CAPABILITY] }),
    createSession: ({ appState }) => {
      const extension = newsExtension(appState, sources);
      return { install: () => [extension] };
    },
  };
}

/** The `DPI_PACK` entry: a device started with `DPI_PACK=…/src/pack.ts` serves the news desk. */
export default createNewsPack();
