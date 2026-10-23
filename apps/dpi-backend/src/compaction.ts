// Per-session compaction thresholds: saved values over the model's defaults, with a refit when an
// agent moves to a window the current margins do not fit.
import {
  compactionFits,
  DEFAULT_COMPACTION,
  defaultCompaction,
  type CompactionSettings,
} from "../../dpi-sdk/src/api.js";
import type { Catalog, SessionRow } from "./catalog.js";
import { invalid } from "./errors.js";
import type { Models } from "./models.js";

export class Compaction {
  /** Saved thresholds per session; null when the session uses the defaults for its model. */
  private readonly saved = new Map<string, Partial<CompactionSettings> | null>();

  constructor(
    private readonly catalog: Catalog,
    private readonly models: Models,
  ) {}

  get(sessionId: string): CompactionSettings {
    if (!this.saved.has(sessionId)) this.saved.set(sessionId, this.catalog.compactionSettings(sessionId));
    const values = this.saved.get(sessionId);
    if (values) return { ...DEFAULT_COMPACTION, ...values };
    return defaultCompaction(this.models.windowOf(this.catalog.getSession(sessionId)?.model ?? ""));
  }

  /** Validate and store new thresholds; pi-durable reads them at its next use, so they apply from the next request. */
  set(row: SessionRow, body: Record<string, unknown>): CompactionSettings {
    const next = this.get(row.id);
    const int = (key: "reserveTokens" | "backgroundTokens" | "keepRecentTokens", min: number, max: number) => {
      if (body[key] === undefined) return;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
      next[key] = n;
    };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
      next.enabled = body.enabled;
    }
    int("reserveTokens", 1024, 1_000_000);
    int("backgroundTokens", 0, 1_000_000);
    int("keepRecentTokens", 500, 200_000);
    this.catalog.setCompactionSettings(row.id, next);
    this.saved.set(row.id, next);
    return { ...next };
  }

  /** When the agent moves to a window the current margins do not fit, replace them with that window's defaults. */
  refitFor(sessionId: string, modelId: string): void {
    const window = this.models.windowOf(modelId);
    if (window && !compactionFits(window, this.get(sessionId))) {
      const fitted = defaultCompaction(window);
      this.catalog.setCompactionSettings(sessionId, fitted);
      this.saved.set(sessionId, fitted);
    }
  }

  forget(sessionId: string): void {
    this.saved.delete(sessionId);
  }
}
