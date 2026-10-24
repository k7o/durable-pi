// dpi-backend: one device of the Durable Agent Network. Boot, HTTP/SSE, sessions, agents and durability only; the
// product on the device comes from a pack, and this binary's default pack is empty.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { Device } from "./device.js";
import { Models } from "./models.js";
import { fauxModels } from "./faux.js";
import { EMPTY_PACK, type DevicePack } from "./pack.js";
import { serve } from "./serve.js";

/** `DPI_PACK` names a module whose default export is a DevicePack; the demo app's own main does the same in code. */
async function loadPack(path: string): Promise<DevicePack> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
  const pack = module.default as Partial<DevicePack> | undefined;
  if (!pack || typeof pack.name !== "string" || typeof pack.createSession !== "function")
    throw Error(`DPI_PACK ${path} must default-export a DevicePack with a name and createSession`);
  return pack as DevicePack;
}

const config = loadConfig();
const pack = config.pack ? await loadPack(config.pack) : EMPTY_PACK;
// `faux` is the device's own offline double, and a pack may replace it with a scripted one (the demo's names its own
// tools). Every other provider is one this build ships.
const models =
  config.provider === "faux"
    ? await (pack.models?.() ?? fauxModels())
    : await Models.open(config.provider, config.defaultModel);
const device = await Device.open(
  {
    dataDir: config.dataDir,
    startDirs: config.startDirs,
    name: config.name,
    models,
  },
  pack,
);
serve(device, config);
