// The SDK's own boundary: the device contract, and one file per pack beside it.
//
// Every client of every device imports `src/` — the wire contract, the client, the models, App State. Two packs also
// keep their wire types here (`packs/demo-jobs`, `packs/demo-todos`, `packs/news`) so a shell can read the JSON a pack
// writes without importing the pack itself. One package is deliberate; keeping the two halves apart is what stops the
// device contract from growing a dependency on a product.
//
// Two rules, one per direction:
//   1. a file in `src/` (the device contract) imports nothing from `src/packs/`;
//   2. a pack imports `src/` freely, and imports nothing from a *different* pack.
//
// Rule 1 is why `JobDef` lives in `api.ts`: `/v1/device` advertises the jobs a device can run, so the shape of an
// advertised job is device wire, while the run record a pack writes stays the pack's own type. Splitting it the other
// way would have put a card from the demo pack's deck in the middle of the contract.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const SRC = resolve(import.meta.dirname, "../src");
const PACKS = join(SRC, "packs");
const IMPORT = /(?:from\s+|import\(\s*)"([^"]+)"/g;

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Resolved path of every module a file imports, with .js normalised to the .ts source it names. */
async function imports(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return [...text.matchAll(IMPORT)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier).replace(/\.js$/, ".ts"));
}

/** Which product a file under `packs/` belongs to: `demo-jobs.ts` and `demo-todos.ts` are one pack. */
const packOf = (file: string) => basename(file).split("-")[0].replace(/\.ts$/, "");

test("layout: the device contract imports nothing from a pack", async () => {
  const found: string[] = [];
  for (const file of await sources(SRC)) {
    if (file.startsWith(PACKS)) continue;
    for (const target of await imports(file)) {
      if (target.startsWith(PACKS)) found.push(`${relative(SRC, file)} → ${relative(SRC, target)}`);
    }
  }
  assert.deepEqual(found, [], `src/ must not depend on a pack:\n${found.join("\n")}`);
});

test("layout: a pack's wire types import no other pack", async () => {
  const found: string[] = [];
  for (const file of await sources(PACKS)) {
    for (const target of await imports(file)) {
      if (!target.startsWith(PACKS) || packOf(target) === packOf(file)) continue;
      found.push(`${relative(SRC, file)} → ${relative(SRC, target)}`);
    }
  }
  assert.deepEqual(found, [], `a pack must not import another pack:\n${found.join("\n")}`);
});
