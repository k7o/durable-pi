// What the news pack promises a client, pinned. A pack is a boundary, so its document kinds, its tool name and order,
// the task it registers and the capability it advertises are the contract a GUI or a test can rely on. Doc kinds are
// namespaced with the app's name, because `GET .../docs/:kind` is flat across packs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_CAPABILITIES } from "../../dpi-backend/src/device.js";
import type { SharedState } from "../../dpi-backend/src/app-state.js";
import type { SpawnSession } from "../../dpi-backend/src/spawn.js";
import { NEWS_CAPABILITY, createNewsPack } from "../src/pack.js";

const refuse = () => {
  throw Error("contract snapshot: this argument is only reached from inside execute()");
};
const appState = refuse as unknown as SharedState;

test("contracts: the pack names itself, adds one document and advertises one capability", () => {
  const pack = createNewsPack();
  assert.equal(pack.name, "news");
  assert.deepEqual(pack.docs?.map((doc) => doc.kind), ["news.stories"]);
  assert.deepEqual(pack.docs?.[0].empty, { items: [], runs: 0 });
  assert.deepEqual(pack.info?.().capabilities, [...DEVICE_CAPABILITIES, NEWS_CAPABILITY]);
  assert.deepEqual(pack.deviceDocs, undefined, "the news desk adds no device-scoped document");
  assert.deepEqual(pack.sessionExtensions, undefined, "one extension, installed rather than selected");
});

test("contracts: one extension offers one tool and registers both tasks", () => {
  const installed = createNewsPack()
    .createSession({ spawn: refuse as unknown as SpawnSession, appState, classify: refuse })
    .install({ sessionId: "contract-session" });
  assert.deepEqual(installed.map((extension) => extension.name), ["news"]);
  assert.deepEqual(installed[0].tools?.map((tool) => tool.name), ["news"]);
  // Order is the registration order, and both are reachable from the tool: `fetch` reads feeds, `digest` summarises.
  assert.deepEqual(installed[0].tasks?.map((task) => task.definition.name), ["news.fetch", "news.digest", "news.triage"]);
  assert.deepEqual(installed[0].sections, undefined, "the pack adds no prompt section yet");
});
