import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Documents } from "../src/documents.js";
import { SharedState } from "../src/playground/shared-state.js";

test("documents: serves the device document and refuses unknown kinds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-documents-"));
  const shared = await SharedState.open(join(dir, "app-state.sqlite"));
  try {
    await shared.initialize({ goal: "Explore durable agents", counter: 0, notes: [] });
    const documents = new Documents(shared);
    const doc = await documents.deviceDoc("app.shared-state");
    assert.deepEqual(doc.value, { goal: "Explore durable agents", counter: 0, notes: [] });
    assert.equal(typeof doc.revision, "number");

    await assert.rejects(() => documents.deviceDoc("demo.nope"), /Unknown device document/);
    await assert.rejects(
      () => documents.agentDoc(null as never, null as never, "demo.nope"),
      /Unknown agent document/,
    );
  } finally {
    await shared.close();
    await rm(dir, { recursive: true, force: true });
  }
});
