// One PID lock per database path. A lock is a file holding the owner's process id: a second opener
// takes over a stale file (its process is gone) and refuses a live one.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Take the lock at `path` and return its release function. Throws when a live process owns it. */
export function lockFile(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const take = () => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = Number(readFileSync(path, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
    }
    if (alive && pid !== process.pid) throw Error(`Database already owned by process ${pid}: ${path}`);
    unlinkSync(path);
    take();
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}
