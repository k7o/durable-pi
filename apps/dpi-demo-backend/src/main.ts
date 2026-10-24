// dpi-demo-backend: the demo device — dpi-backend, plus the playground pack. The device owns boot, HTTP and
// durability; everything demo-specific is the pack in src/playground/pack.ts.
import { loadConfig } from "../../dpi-backend/src/config.js";
import { Device } from "../../dpi-backend/src/device.js";
import { Models } from "../../dpi-backend/src/models.js";
import { serve } from "../../dpi-backend/src/serve.js";
import { fauxModels } from "./faux.js";
import { createDemoPack } from "./playground/pack.js";

const config = loadConfig();
const models = config.provider === "faux" ? await fauxModels() : await Models.open(config.provider, config.defaultModel);
const device = await Device.open(
  { dataDir: config.dataDir, startDirs: config.startDirs, name: config.name, models },
  createDemoPack({ offline: config.provider === "faux" }),
);
serve(device, config);
