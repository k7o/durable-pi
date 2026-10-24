// Device configuration: ~/.dpi/backend.env (or $DPI_ENV_FILE) plus CLI flags.
// Nothing here knows about specific machines; dpi-network.yaml on the operator's laptop
// writes this env file through `just net up <device>`.
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { defaultModelByProvider } from "./model-catalog.js";
import { PROVIDER_CREDENTIALS, isProviderId, PROVIDER_IDS, type ProviderId } from "./provider.js";

export interface BackendConfig {
  name: string;
  host: string;
  port: number;
  home: string;
  envFile: string;
  dataDir: string;
  startDirs: string[];
  provider: ProviderId;
  /** The model a session starts on when it does not name one. */
  defaultModel: string;
  /** A DevicePack module path for the device binary; empty means the bare device. */
  pack?: string;
  token: string;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(argv = process.argv.slice(2), env = process.env): BackendConfig {
  const flag = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return fallback;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${key} needs a value`);
    return value;
  };
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  const envFile = expand(flag("--env-file", env.DPI_ENV_FILE ?? join(home, "backend.env")));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const provider = env.DPI_PROVIDER ?? "openrouter";
  if (!isProviderId(provider))
    throw Error(`DPI_PROVIDER must be one of ${PROVIDER_IDS.join(", ")} (got "${provider}")`);
  const config: BackendConfig = {
    name: flag("--name", env.DPI_DEVICE_NAME ?? hostname().replace(/\.local$/, "")),
    host: flag("--host", env.DPI_HOST ?? "127.0.0.1"),
    port: Number(flag("--port", env.DPI_PORT ?? "4780")),
    home,
    envFile,
    dataDir: resolve(expand(flag("--data-dir", env.DPI_DATA_DIR ?? join(home, "backend")))),
    startDirs: flag("--start-dirs", env.DPI_START_DIRS ?? "~/dpi-work")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(expand(p))),
    provider,
    defaultModel: flag("--model", env.DPI_MODEL ?? defaultModelByProvider[provider]),
    pack: env.DPI_PACK,
    token: env.DPI_TOKEN ?? "",
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw Error(`Invalid port: ${config.port}`);
  if (config.token.length < 32)
    throw Error(
      `DPI_TOKEN is missing or shorter than 32 characters (looked in ${envFile}). Create one with: npm run token`,
    );
  if (config.provider !== "faux") {
    const missing = PROVIDER_CREDENTIALS[config.provider].find((name) => !env[name]);
    if (missing)
      console.warn(
        `warning: ${missing} is not set, so this device will list no models. ` +
          `Add it to ${envFile} or the process environment.`,
      );
  }
  return config;
}
