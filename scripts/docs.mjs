// Every relative link and image in the tracked Markdown resolves to a file in the checkout.
//
// This is the cheap half of documentation drift: a moved file breaks the links that point at it, and the
// browser in a reviewer's head is the only other thing that notices. Prose that *names* a path in backticks
// is deliberately not checked, because `docs/agents/*.md` and `ai_docs/durable_pi/maintainability-audit.md`
// record layouts that are gone on purpose, and a rule that has to tell history from current text costs more
// than it catches.
//
// Vendored trees are skipped: `.claude/` holds a copied skill and its own README, and `ai_docs/pi/` holds
// upstream notes with placeholder links.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skipped = [".claude/", "ai_docs/pi/"];
const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => !skipped.some((prefix) => file.startsWith(prefix)));

const refs = /\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"/g;
let checked = 0;
const broken = [];
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8");
  for (const match of text.matchAll(refs)) {
    const ref = match[1] ?? match[2];
    if (/^(https?:|mailto:|#)/.test(ref)) continue;
    checked++;
    const target = resolve(dirname(join(root, file)), ref.split("#")[0]);
    if (!existsSync(target)) broken.push(`${file}: ${ref} does not exist`);
  }
}

for (const line of broken) console.log(`FAIL ${line}`);
console.log(`${files.length} files, ${checked} relative links, ${broken.length} broken`);
if (broken.length) process.exit(1);
