import { test } from "node:test";
import assert from "node:assert/strict";
import { Models } from "../src/models.js";
import { faux, fauxModels } from "../src/faux.js";

test("models: faux lists one deterministic model and routes anything else to it", async () => {
  const models = await fauxModels();
  assert.deepEqual(models.list.map((m) => m.id), ["echo"]);
  assert.equal(models.defaultModelId, "echo");
  assert.equal(models.windowOf("echo"), 128000);
  assert.equal(models.windowOf("missing"), 0);

  assert.deepEqual(models.routed(), { provider: "faux", modelId: "echo" });
  assert.deepEqual(models.routed({ provider: "faux", modelId: "echo" }), { provider: "faux", modelId: "echo" });
  assert.deepEqual(models.routed({ provider: "openrouter", modelId: "anthropic/claude" }), {
    provider: "faux",
    modelId: "echo",
  });
});

test("models: accepts only a model from this device's catalog", async () => {
  const models = await fauxModels();
  assert.deepEqual(models.validate({ provider: "faux", modelId: "echo" }), { provider: "faux", modelId: "echo" });
  assert.throws(() => models.validate({ provider: "faux", modelId: "missing" }), /Unknown model/);
  assert.throws(() => models.validate({ provider: "openrouter", modelId: "echo" }), /Unknown model/);
  assert.throws(() => models.validate(undefined), /model must be/);
});

test("models: faux is a device binary's offline double, not a provider Models.open ships", async () => {
  // The double lives in src/faux.ts and every device entrypoint wires it for DPI_PROVIDER=faux; `Models.open` is the
  // real-provider path and must keep saying no, or a deployed device would start with a model that cannot answer.
  await assert.rejects(() => Models.open("faux"), /offline model/);
  assert.deepEqual(faux, { provider: "faux", modelId: "echo" });
  const models = await fauxModels();
  assert.equal(models.defaultModelId, "echo");
});
