import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Documents } from "../src/documents.js";
import { createDemoPack } from "../src/playground/pack.js";

test("documents: serves the pack's device document and refuses unknown kinds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dpi-documents-"));
  const pack = createDemoPack({ offline: true });
  await pack.open({ dataDir: dir, appStatePath: join(dir, "app-state.sqlite"), notify: () => {} });
  try {
    const documents = new Documents(pack);
    const doc = await documents.deviceDoc("app.shared-state");
    assert.deepEqual(doc.value, { goal: "Explore durable agents", counter: 0, notes: [] });
    assert.equal(typeof doc.revision, "number");

    await assert.rejects(() => documents.deviceDoc("demo.nope"), /Unknown device document/);
    await assert.rejects(
      () => documents.agentDoc(null as never, null as never, "demo.nope"),
      /Unknown agent document/,
    );
  } finally {
    await pack.close();
    await rm(dir, { recursive: true, force: true });
  }
});
