// The demo app must stay deletable: nothing under apps/dpi-backend/src may import it. This is the one guard that makes
// the pack seam a boundary instead of a convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dirname, "../src");
const DEMO = `${sep}dpi-demo-backend${sep}`;
const IMPORT = /(?:from\s+|import\(\s*)"([^"]+)"/g;

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
    ),
  );
  return files.flat();
}

test("layout: the device imports nothing from the demo app", async () => {
  const offenders: string[] = [];
  for (const file of await sources(SRC)) {
    const text = await readFile(file, "utf8");
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier.startsWith(".")) continue;
      if (resolve(dirname(file), specifier).includes(DEMO)) offenders.push(`${relative(SRC, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});
