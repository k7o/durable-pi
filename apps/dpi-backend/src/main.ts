// dpi-backend: one device of the Durable Agent Network.
import express from "express";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { Device } from "./device.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";
import { createDemoPack } from "./playground/pack.js";

const config = loadConfig();
const device = await Device.open(
  {
    dataDir: config.dataDir,
    startDirs: config.startDirs,
    name: config.name,
    provider: config.provider,
    defaultModel: config.defaultModel,
  },
  createDemoPack({ offline: config.provider === "faux" }),
);

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/v1", bearerAuth(config.token), express.json({ limit: "256kb" }), v1(device));
app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`dpi-backend "${config.name}" (uid ${device.uid}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`);
  console.log(`default model: ${config.defaultModel}  models: ${device.deviceInfo().models.length}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await device.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
