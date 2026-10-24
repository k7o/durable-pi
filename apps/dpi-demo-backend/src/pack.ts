// The demo pack as a module, for a device that loads its pack by path: `DPI_PACK=/opt/durable-pi/apps/
// dpi-demo-backend/src/pack.ts` on a sandboxed or deployed device keeps dpi-backend as the entrypoint and still
// serves the playground. The demo app's own main (`src/main.ts`) passes the same pack in code.
import { createDemoPack } from "./playground/pack.js";

export default createDemoPack({ offline: process.env.DPI_PROVIDER === "faux" });
