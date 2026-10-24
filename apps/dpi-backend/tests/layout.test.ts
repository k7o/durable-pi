// The seam is a boundary, not a convention, and it has two directions. Nothing under apps/dpi-backend/src may import an
// app built on it, and an app's product code may import the device only through `src/pack-api.ts`. Both guards name the
// apps rather than one of them: a guard that only knows the demo would pass vacuously on the second app.
//
// Tests are exempt from the second rule. A pack's suite stands in for the engine — it builds an API object, drives a
// tool, inspects entries — so it needs the modules the product code must not touch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dirname, "../src");
const APPS_ROOT = resolve(import.meta.dirname, "../..");
// Product apps on the seam. `dpi-sdk` is not here: it is the shared wire contract, and the device owns it.
const APP_NAMES = ["dpi-demo-backend", "dpi-news-backend", "proactive-dpi-demo"];
const APPS = APP_NAMES.map((name) => `${sep}${name}${sep}`);
const PACK_API = join(SRC, "pack-api.ts");
const DEVICE_SRC = `${sep}dpi-backend${sep}src${sep}`;
const IMPORT = /(?:from\s+|import\(\s*)"([^"]+)"/g;

async function sources(dir: string, skip: (path: string) => boolean = () => false): Promise<string[]> {
  if (skip(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sources(join(dir, entry.name), skip)
        : entry.name.endsWith(".ts")
          ? [join(dir, entry.name)]
          : [],
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

test("layout: an app imports the device only through the pack API", async () => {
  const offenders: string[] = [];
  // `node_modules` is never ours; `tests` and `*.test.ts` are the suites that stand in for the engine; `dist` is build
  // output. Everything else in an app is product code and obeys the seam.
  const skip = (path: string) =>
    path.includes(`${sep}node_modules`) ||
    path.includes(`${sep}tests`) ||
    path.includes(`${sep}dist`) ||
    path.endsWith(".test.ts");
  for (const app of APP_NAMES) {
    for (const file of await sources(join(APPS_ROOT, app), skip)) {
      const text = await readFile(file, "utf8");
      for (const [, specifier] of text.matchAll(IMPORT)) {
        if (!specifier.startsWith(".")) continue;
        // The specifier names the compiled path; the source it points at is what gets compared.
        const target = resolve(dirname(file), specifier).replace(/\.js$/, ".ts");
        if (!target.includes(DEVICE_SRC) || target === PACK_API) continue;
        offenders.push(`${relative(APPS_ROOT, file)} → ${specifier}`);
      }
    }
  }
  assert.ok(existsSync(PACK_API), "the pack API exists");
  assert.deepEqual(offenders, []);
});
