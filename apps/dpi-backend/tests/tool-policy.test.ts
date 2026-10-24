import { test } from "node:test";
import assert from "node:assert/strict";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "@earendil-works/pi-ai";
import { withWrites, writing, writes } from "../src/tool-policy.js";

const tool = (name: string) =>
  defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "" }] }),
  });

test("tool policy: a tool declares that it writes", () => {
  const reader = tool("read");
  const writer = writing(tool("write"));
  assert.equal(writes(reader), false);
  assert.equal(writes(writer), true);
});

test("tool policy: an installed extension gets the policy its installer declares", () => {
  const extension = defineExtension({ name: "custom", tools: [tool("one"), tool("two")] });
  const installed = withWrites(extension, ["two"]);
  assert.equal(writes(installed.tools![0]), false);
  assert.equal(writes(installed.tools![1]), true);
  assert.equal(writes(extension.tools![1]), false, "the original extension is untouched");
});

test("tool policy: a declared name that the extension does not define is refused", () => {
  const extension = defineExtension({ name: "custom", tools: [tool("one")] });
  assert.throws(() => withWrites(extension, ["one", "typo"]), /typo/);
});

test("tool policy: the coding tools declare bash, write and edit", () => {
  const installed = withWrites(CodingTools, ["bash", "write", "edit"]);
  const marked = installed.tools!.filter(writes).map((t) => t.name);
  assert.deepEqual(marked.sort(), ["bash", "edit", "write"]);
});
