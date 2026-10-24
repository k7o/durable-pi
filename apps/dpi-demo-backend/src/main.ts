import { loadConfig, Device, Models, serve } from "../../dpi-backend/src/pack-api.js";
// dpi-demo-backend: the demo device — dpi-backend, plus the playground pack. The device owns boot, HTTP and
// durability; everything demo-specific is the pack in src/playground/pack.ts.

import { fauxModels } from "./faux.js";
import { createDemoPack } from "./playground/pack.js";

const config = loadConfig();
const models = config.provider === "faux" ? await fauxModels() : await Models.open(config.provider, config.defaultModel);
const device = await Device.open(
  { dataDir: config.dataDir, startDirs: config.startDirs, name: config.name, models },
  createDemoPack({ offline: config.provider === "faux" }),
);
serve(device, config);
