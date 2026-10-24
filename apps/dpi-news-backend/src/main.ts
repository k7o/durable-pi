// dpi-news-backend: the news desk device — dpi-backend plus the news pack. The device owns boot, HTTP and durability;
// everything news-specific is the pack in src/pack.ts.
//
// This app has no model of its own, so it needs a real provider here (`DPI_PROVIDER`); `faux` belongs to the demo app.
import { loadConfig } from "../../dpi-backend/src/config.js";
import { Device } from "../../dpi-backend/src/device.js";
import { Models } from "../../dpi-backend/src/models.js";
import { serve } from "../../dpi-backend/src/serve.js";
import { createNewsPack } from "./pack.js";

const config = loadConfig();
const models = await Models.open(config.provider, config.defaultModel);
const device = await Device.open(
  { dataDir: config.dataDir, startDirs: config.startDirs, name: config.name, models },
  createNewsPack(),
);
serve(device, config);
