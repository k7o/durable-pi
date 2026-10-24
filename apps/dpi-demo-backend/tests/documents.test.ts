// App State is the device's document now, so this opens a real device on the demo pack and reads it through the route
// layer that serves it, rather than hand-building the document registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDevice } from "./helpers.js";

test("documents: serves the device's App State and refuses unknown kinds", async () => {
  const t = await tempDevice();
  const store = await t.open();
  try {
    const doc = await store.documents.deviceDoc("app.shared-state");
    assert.deepEqual(doc.value, { goal: "Explore durable agents", counter: 0, notes: [] });
    assert.equal(typeof doc.revision, "number");
    // The pack adds no device document of its own; App State is the device's, not the demo's.
    assert.deepEqual(store.documents.deviceKinds, ["app.shared-state"]);
    assert.deepEqual(t.pack.deviceDocs, undefined);

    await assert.rejects(() => store.documents.deviceDoc("demo.nope"), /Unknown device document/);
    await assert.rejects(
      () => store.documents.agentDoc(null as never, null as never, "demo.nope"),
      /Unknown agent document/,
    );
  } finally {
    await store.close();
    await t.cleanup();
  }
});
