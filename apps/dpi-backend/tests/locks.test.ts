import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../src/locks.js";

async function tempLock() {
  const dir = await mkdtemp(join(tmpdir(), "dpi-lock-"));
  return { dir, path: join(dir, "db.sqlite.lock"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("lock: a live process keeps the lock, a dead one is taken over", async () => {
  const t = await tempLock();
  try {
    const release = lockFile(t.path);
    assert.equal(readFileSync(t.path, "utf8"), String(process.pid));
    release();
    assert.equal(existsSync(t.path), false);

    // A child that has exited leaves a stale pid behind.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    writeFileSync(t.path, String(child.pid));
    const takeover = lockFile(t.path);
    assert.equal(readFileSync(t.path, "utf8"), String(process.pid));
    takeover();

    // This test's parent is alive, so the lock is refused.
    writeFileSync(t.path, String(process.ppid));
    assert.throws(() => lockFile(t.path), /Database already owned by process/);
    assert.equal(readFileSync(t.path, "utf8"), String(process.ppid), "the refused lock is left alone");
  } finally {
    await t.cleanup();
  }
});

test("lock: releasing only removes a lock the caller still owns", async () => {
  const t = await tempLock();
  try {
    const release = lockFile(t.path);
    writeFileSync(t.path, "1234567");
    release();
    assert.equal(readFileSync(t.path, "utf8"), "1234567", "another owner's lock survives");
  } finally {
    await t.cleanup();
  }
});

test("lock: a second lock in the same process is refused", async () => {
  const t = await tempLock();
  try {
    const release = lockFile(t.path);
    assert.throws(() => lockFile(t.path), /Database already owned by this process/);
    release();
    const again = lockFile(t.path);
    again();
  } finally {
    await t.cleanup();
  }
});
