// The device catalog: catalog.sqlite and the one lock that owns it. It records sessions, agent
// names, the device uid, idempotency keys and per-session compaction thresholds.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { CompactionSettings } from "../../dpi-sdk/src/api.js";
import type { ChangeFeed } from "./changes.js";
import { ApiFault, invalid, notFound } from "./errors.js";
import { lockFile } from "./locks.js";

export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  dbPath: string;
  createdAt: number;
  model: string;
  provider: string;
};

export class Catalog {
  private readonly db: DatabaseSync;
  readonly deviceUid: string;
  private readonly unlock: () => void;

  private constructor(
    private readonly changes: ChangeFeed,
    db: DatabaseSync,
    unlock: () => void,
  ) {
    this.db = db;
    this.unlock = unlock;
    const uid = db.prepare("SELECT value FROM meta WHERE key='device_uid'").get() as { value: string } | undefined;
    this.deviceUid = uid?.value ?? randomUUID();
    if (!uid) db.prepare("INSERT INTO meta(key,value) VALUES('device_uid',?)").run(this.deviceUid);
    // Idempotency keys live at least 24h.
    db.prepare("DELETE FROM requests WHERE createdAt < ?").run(Date.now() - 24 * 3600_000);
  }

  static async open(dataDir: string, changes: ChangeFeed): Promise<Catalog> {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "catalog.sqlite");
    const unlock = lockFile(`${path}.lock`);
    try {
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,name TEXT NOT NULL,cwd TEXT NOT NULL,dbPath TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL,model TEXT NOT NULL,provider TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversation_names(sessionId TEXT NOT NULL,conversationId INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(sessionId,conversationId));
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,route TEXT NOT NULL,status INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_spawns(key TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_compaction(sessionId TEXT PRIMARY KEY,settings TEXT NOT NULL);`);
      return new Catalog(changes, db, unlock);
    } catch (e) {
      unlock();
      throw e;
    }
  }

  // ------------------------------------------------------------ sessions

  listSessions(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY createdAt DESC").all() as SessionRow[]).map(
      (row) => ({ ...row }),
    );
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    return row && { ...row };
  }

  /** Add a session row; `spawnKey` records the tool call that created it in the same transaction. */
  insertSession(row: SessionRow, spawnKey?: string): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)")
        .run(row.id, row.name, row.cwd, row.dbPath, row.createdAt, row.model, row.provider);
      if (spawnKey) this.db.prepare("INSERT OR REPLACE INTO session_spawns VALUES(?,?)").run(spawnKey, row.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.changes.notify();
  }

  /** A session by UUID or unique case-insensitive name. */
  resolveSession(ref: string): SessionRow {
    const byId = this.getSession(ref);
    if (byId) return byId;
    const matches = (
      this.db.prepare("SELECT * FROM sessions WHERE lower(name)=lower(?)").all(ref) as SessionRow[]
    ).map((row) => ({ ...row }));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new ApiFault("ambiguous", `${matches.length} sessions are named "${ref}"; use the session id`);
    throw notFound(`No session "${ref}"`);
  }

  renameSession(id: string, name: string): void {
    this.db.prepare("UPDATE sessions SET name=? WHERE id=?").run(name, id);
    this.changes.notify();
  }

  /** Drop the session row, its agent names and its saved thresholds. The session's files move elsewhere first. */
  forgetSession(id: string): void {
    this.db.prepare("DELETE FROM conversation_names WHERE sessionId=?").run(id);
    this.db.prepare("DELETE FROM session_compaction WHERE sessionId=?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    this.changes.notify();
  }

  setSessionModel(id: string, model: ModelRef): void {
    this.db.prepare("UPDATE sessions SET model=?,provider=? WHERE id=?").run(model.modelId, model.provider, id);
    this.changes.notify();
  }

  // ------------------------------------------------------------ agent names

  agentNames(sessionId: string): Map<number, string> {
    return new Map(
      (
        this.db.prepare("SELECT conversationId,name FROM conversation_names WHERE sessionId=?").all(sessionId) as {
          conversationId: number;
          name: string;
        }[]
      ).map((row) => [row.conversationId, row.name]),
    );
  }

  setAgentName(sessionId: string, agentId: number, name: string): void {
    this.db
      .prepare(
        "INSERT INTO conversation_names VALUES(?,?,?) ON CONFLICT(sessionId,conversationId) DO UPDATE SET name=excluded.name",
      )
      .run(sessionId, agentId, name);
    this.changes.notify();
  }

  // ------------------------------------------------------------ compaction

  compactionSettings(sessionId: string): Partial<CompactionSettings> | null {
    const row = this.db.prepare("SELECT settings FROM session_compaction WHERE sessionId=?").get(sessionId) as
      | { settings: string }
      | undefined;
    return row ? (JSON.parse(row.settings) as Partial<CompactionSettings>) : null;
  }

  /** `null` removes the row so the session falls back to its model's defaults. */
  setCompactionSettings(sessionId: string, settings: Partial<CompactionSettings> | null): void {
    if (settings === null) this.db.prepare("DELETE FROM session_compaction WHERE sessionId=?").run(sessionId);
    else
      this.db
        .prepare("INSERT INTO session_compaction VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET settings=excluded.settings")
        .run(sessionId, JSON.stringify(settings));
    this.changes.notify();
  }

  // ------------------------------------------------------------ idempotency

  replay(key: string, route: string): { status: number; body: unknown } | undefined {
    const row = this.db.prepare("SELECT * FROM requests WHERE key=?").get(key) as
      | { route: string; status: number; body: string }
      | undefined;
    if (!row) return undefined;
    if (row.route !== route) throw invalid("Idempotency-Key was already used for a different request");
    return { status: row.status, body: JSON.parse(row.body) as unknown };
  }

  remember(key: string, route: string, status: number, body: unknown): void {
    this.db
      .prepare("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?)")
      .run(key, route, status, JSON.stringify(body), Date.now());
  }

  // ------------------------------------------------------------ spawn replay

  spawnOwner(key: string): string | undefined {
    const row = this.db.prepare("SELECT sessionId FROM session_spawns WHERE key=?").get(key) as
      | { sessionId: string }
      | undefined;
    return row?.sessionId;
  }

  recordSpawn(key: string, sessionId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO session_spawns VALUES(?,?)").run(key, sessionId);
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } finally {
      this.unlock();
    }
  }
}
