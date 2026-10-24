// dpi-news-backend: the news desk device — dpi-backend plus the news pack. The device owns boot, HTTP and durability;
// everything news-specific is the pack in src/pack.ts.
//
// This app has no model of its own, so it uses the device's offline double for `DPI_PROVIDER=faux` and a real provider
// otherwise.
import { loadConfig } from "../../dpi-backend/src/config.js";
import { Device } from "../../dpi-backend/src/device.js";
import { fauxModels } from "../../dpi-backend/src/faux.js";
import { Models } from "../../dpi-backend/src/models.js";
import { serve } from "../../dpi-backend/src/serve.js";
import { createNewsPack } from "./pack.js";

const config = loadConfig();
const models = config.provider === "faux" ? await fauxModels() : await Models.open(config.provider, config.defaultModel);
const device = await Device.open(
  { dataDir: config.dataDir, startDirs: config.startDirs, name: config.name, models },
  createNewsPack(),
);
serve(device, config);
