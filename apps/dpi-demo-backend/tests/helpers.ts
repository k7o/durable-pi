// Helpers for the demo app's tests: a temp demo device with the pack and the fake model, and the real demo binary on
// a port. The device's own tests do not boot a server; everything that exercises the demo lives here.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Device } from "../../dpi-backend/src/device.js";
import { faux, fauxModels } from "../src/faux.js";
import { createDemoPack } from "../src/playground/pack.js";

export { faux };

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(fn: () => Promise<boolean>, timeout = 15000, what = "condition") {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error(`Timed out waiting for ${what}`);
}

/** A temp data dir and working folder, opened as a demo device. Reopen with `open()` after a close. */
export async function tempDevice() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-demo-")));
  await mkdir(join(root, "work", "project", "nested"), { recursive: true });
  const options = {
    dataDir: join(root, "data"),
    startDirs: [join(root, "work")],
    name: "test",
    models: await fauxModels(),
  };
  const pack = createDemoPack({ offline: true });
  return {
    root,
    work: join(root, "work"),
    options,
    pack,
    open: () => Device.open(options, pack),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

export const newToken = () => `dpi_${randomBytes(32).toString("base64url")}`;

/** Boot the real demo app as a child process (faux provider, temp DPI_HOME). */
export async function bootServer(opts: { home: string; startDirs: string; token: string; port?: number; name?: string; cwd?: string }) {
  const port = opts.port ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = "";
  const start = async () => {
    child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "../src/main.ts"), "--port", String(port), "--host", "127.0.0.1"],
      {
        env: {
          ...process.env,
          DPI_HOME: opts.home,
          DPI_ENV_FILE: resolve(opts.home, "none.env"),
          DPI_TOKEN: opts.token,
          DPI_PROVIDER: "faux",
          DPI_START_DIRS: opts.startDirs,
          DPI_DEVICE_NAME: opts.name ?? "test-device",
        },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: opts.cwd ?? resolve(import.meta.dirname, ".."),
      },
    );
    child.stdout?.on("data", (x) => (output += x));
    child.stderr?.on("data", (x) => (output += x));
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {}
      if (child.exitCode !== null) throw Error(output);
      await delay(100);
    }
    throw Error("Server did not start: " + output);
  };
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill(signal);
      await exited;
    }
  };
  await start();
  return { base, port, start, stop, output: () => output };
}
