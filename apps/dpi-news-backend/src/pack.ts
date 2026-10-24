// The news desk pack: the device's one seam. Everything this app is lives here — one conversation document, one tool,
// one task — and nothing in apps/dpi-backend changes to run it. Load it by path (`DPI_PACK=/…/src/pack.ts`) or pass
// `createNewsPack()` from this app's own entrypoint (`src/main.ts`).
//
// The task takes the device's App State store, which the device opens and hands to `createSession`, so this app records
// its last run in the same shared document the demo does without importing the demo.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  DEVICE_CAPABILITIES,
  writing,
  type SharedState,
  type ConversationDoc,
  type DevicePack,
} from "../../dpi-backend/src/pack-api.js";
import { STORIES_DOC, type StoriesDoc } from "../../dpi-sdk/src/news.js";
import { createNewsDigest } from "./digest.js";
import { Stories } from "./stories.js";
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
 * One extension, so the whole app is one line in a session's tool list. The tool and the task share one digest
 * definition, which is what makes `digest` start the same task the session registers.
 */
export function newsExtension(appState: SharedState) {
  const digest = createNewsDigest(appState);
  return defineExtension({
    name: "news",
    tools: [writing(createNewsTool(digest))],
    tasks: [digest],
  });
}

export function createNewsPack(): DevicePack {
  return {
    name: "news",
    docs,
    info: () => ({ capabilities: [...DEVICE_CAPABILITIES, NEWS_CAPABILITY] }),
    createSession: ({ appState }) => {
      const extension = newsExtension(appState);
      return { install: () => [extension] };
    },
  };
}

/** The `DPI_PACK` entry: a device started with `DPI_PACK=…/src/pack.ts` serves the news desk. */
export default createNewsPack();
