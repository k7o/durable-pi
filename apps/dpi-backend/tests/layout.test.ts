// Every app must stay deletable: nothing under apps/dpi-backend/src may import one. This is the one guard that makes
// the pack seam a boundary instead of a convention, so it names the apps rather than one of them — a guard that only
// knows the demo would pass vacuously on the second app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dirname, "../src");
// Product apps on the seam. `dpi-sdk` is not here: it is the shared wire contract, and the device owns it.
const APPS = ["dpi-demo-backend", "dpi-news-backend", "proactive-dpi-demo"].map((name) => `${sep}${name}${sep}`);
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

test("layout: the device imports nothing from an app built on it", async () => {
  const offenders: string[] = [];
  for (const file of await sources(SRC)) {
    const text = await readFile(file, "utf8");
    for (const [, specifier] of text.matchAll(IMPORT)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (APPS.some((app) => target.includes(app))) offenders.push(`${relative(SRC, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});
