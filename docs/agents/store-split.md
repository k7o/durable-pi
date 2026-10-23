# Store split: plan

Status: **corrections accepted**. Slice 1 landed (see [Progress](#progress)). No other source file has
been changed. `GLOSSARY.md` is new (agent vs conversation). Everything below is derived from
`store.ts` (1,171 lines after slice 1, 57 public methods, 68 internal self-calls) and the method map
in `/tmp/arch-review/store-callgraph.md`.

## Progress

| Slice | State | Evidence |
|---|---|---|
| 1 · Locks + change feed | done | `src/locks.ts`, `src/changes.ts`; `tests/locks.test.ts`, `tests/changes.test.ts`; `npm run check` clean; 16/16 tests pass; `process.kill` no longer in `store.ts`; −33/+6 lines in `store.ts` |
| 2 · Catalog | done | `src/catalog.ts` (`deviceUid`, 14 intent methods, schema + 24h GC, own lock); `tests/catalog.test.ts` (9 tests: uid, rows, resolve, names, model, compaction, replay, spawns, lock, GC); `store.ts` 1,171 → 1,103; `DatabaseSync`/`.prepare(` gone from `store.ts`; routes/streams unchanged; 26/26 tests pass. **Measured −68 lines, not ≥150:** the schema/constructor were smaller than estimated and delegates re-add lines. Guardrail restated: SQL-free + catalog contract tests, not a line count. |
| 3 · Tool policy | done | `src/tool-policy.ts`; `writing`/`withWrites` mark tools at their definition; `WRITE_TOOLS` deleted; `todo` was missing from the old set and is now correctly a write (readOnly removes 9, not 8); `tests/tool-policy.test.ts` (4 tests); `store.test.ts` read-only asserts a literal list; `API.md` corrected; 30/30 tests pass |
| 4 · Models | done | `src/models.ts` (provider registration, curated picker list, routing, validation, windows); `tests/models.test.ts` (2 tests); `store.ts` 1,092 → 1,021 |
| 5 · Compaction | done | `src/compaction.ts` (defaults, saved thresholds, refit, forget); `tests/compaction.test.ts` (4 tests); `store.ts` 1,021 → 997 |
| 6 · Documents | done | `src/documents.ts` (kind registry, `agentDoc`, `deviceDoc`); `tests/documents.test.ts`; `store.ts` 997 → 987 |
| 7 · SessionRuntime | done | `src/session-runtime.ts` (open sessions, harness/jobs/addons, locks, archive, browse, cwd, start dirs); `tests/session-runtime.test.ts` (5 tests); `streams.ts` uses `isOpen`; `store.ts` 987 → 860 |
| 8 · Conversations | done | `src/conversations.ts` (input, submissions, history, inbox, usage, tasks, labels); `tests/conversations.test.ts` (2 tests); `store.ts` 860 → 724 |
| 9 · Agents | done | `src/agents.ts` (resolve, list, summary, detail, name, create, fork, configure); `tests/agents.test.ts` (3 tests); `store.ts` 724 → 588 |
| 10 · Playground | done | `src/playground.ts` (App State, job start, approval); existing demo/job tests unchanged; `store.ts` 588 → 547 |
| 11 · Root + rename | done | `src/device.ts` replaces `src/store.ts`; `Store` → `Device`; `tempStore` → `tempDevice`; no SQL, no fs, no harness construction in the root; all suites green (backend 47, SDK 14, TUI, playground) |

Note: slices 1–3 are on one branch, `refactor/store-split`, with one commit per slice where the files allowed it (2 and 3 share `store.ts`, so they are one commit).

**Slice 11 overshoot:** `device.ts` is 417 lines, not ≤200. The extra is 40 one-line delegates (the price of Q1's facade keeping 64 call sites) plus eight use cases: `create`, `spawnSession`, `rename`, `preview`, `extensionsOf`, `setExtension`, `sessionSummaryBase`/`sessionSummary`, `tree`, `deviceInfo`. Every body is a delegation or one of those documented joins; no SQL, no fs, no harness construction. Shrinking further means either re-pointing routes/streams at modules (reopening Q1) or extracting agent-extension selection into its own module.

## Goal

Turn `apps/dpi-backend/src/store.ts` into a composition root over deep modules with small interfaces,
without changing the HTTP or SSE contract.

Non-goals, this pass:

- the duplicated provider catalog in `proactive-dpi-demo` (candidate 2)
- unifying the six idempotency mechanisms (candidate 5)
- the demo's missing SDK seam (candidate 6)
- the three reconnect loops
- `errors.ts` message-regex mapping

## Target modules

```
routes / streams
      │
      ▼
  Device (composition root, ≤ ~200 lines)
      │
      ├── Agents ──────────► Conversations, SessionRuntime, Catalog, Models, Compaction, Changes
      ├── SessionRuntime ──► Catalog, Models, Compaction, Changes, Locks, Playground (factory)
      ├── Playground ──────► Documents (conversation handles passed in)
      ├── Documents ───────► SharedState
      ├── Compaction ──────► Catalog, Models, Changes
      ├── Models ──────────► provider catalog
      ├── Catalog ─────────► Locks, Changes
      ├── Changes          (leaf)
      └── Locks            (leaf)
```

No module imports a module that imports it. The two previously accepted cross-module use cases
(`create`, `spawnSession`) move to the root — see [Correction A](#correction-a-revise-q3).

Residual calls the root keeps: `deviceInfo`, `open`, `close`, `tree`, `sessionSummary`,
`sessionSummaryBase`, `rename`, `create`, `spawnSession`, `preview`. Each is either wiring or a join
across modules.

## Decisions carried in

| # | Decision |
|---|---|
| Q1 | Keep one thin composition root; routes and streams keep calling it |
| Q2 | Land one slice at a time, Catalog first |
| Q3 | `create`/`archive`/`spawnSession` are use cases — **revised below** |
| Q4 | `ChangeFeed` module injected where writes happen |
| Q5 | `Agents` owns agent resolution/projection; `tree` and `sessionSummary` stay in the root |
| Q6 | `Catalog` owns all six `catalog.sqlite` tables; `lockFile` moves to `locks.ts` |
| Q7 | Names: `Catalog`, `SessionRuntime`, `Agents`, `Conversations`, `Models`, `Compaction`, `Documents`, `Playground`, `Changes` |
| Q8 | New contract test at the new seam; existing integration tests untouched |
| Q9 | Root has no SQL, no `node:fs`, no harness/registry construction |
| Q10 | One slice per change, flat files in `src/` |
| Q11 | `Conversations` is the fifth module (the 16-method closed set) |
| Q12 | `Models` and `Compaction` are modules; browsing stays in `SessionRuntime`; `deviceInfo` in the root |
| Q13 | Root keeps `rename`, `tree`, `sessionSummary`; demo endpoints go to `Playground` |
| Q14 | Catalog exposes intent-level methods |
| Q15 | The module that owns a write notifies the feed |
| Q16 | Task nodes and labels go to `Conversations` |
| Q17 | `Documents` owns the doc-kind registry and `agentDoc`/`deviceDoc` |
| Q18 | Keep `ApiFault` as the error vocabulary |
| Q19 | Candidate 3 (write-ness from tool definitions) lands right after Catalog |
| Q20 | Keep `Store` during the move; rename to `Device` in the final slice |
| Q21 | Branch and PR per slice, merged in dependency order |
| Q22 | Acceptance checks per slice — **staged correction below** |

## Corrections to settled answers

### Correction A (needs your yes): revise Q3

Q3 put `create`, `archive` and `spawnSession` on `SessionRuntime`. The method map shows that creates
a module cycle:

- `SessionRuntime.spawnSession → Agents.resolveAgent` (E28) and `… → Agents.sessionSummary` (E29)
- `Agents.resolveAgent → SessionRuntime.harness` (E19) and `… → SessionRuntime.scanAll` (E20)

**Proposed:** keep `archive` in `SessionRuntime` (it reaches only `scanAll`, the feed and the
catalog). Move `create` and `spawnSession` to the root, where the other cross-module use cases
already live. The root then wires `Models.validate → Catalog.insertSession → SessionRuntime.open →
Agents.sessionSummary`, and `Catalog.spawnOwner → Agents.resolve → Conversations.send` for
`spawnSession`. Result: every module edge points one way.

### Correction B (needs your yes): facade size

Q9's target of ≤150 lines assumed ~40 delegates. With 47 one-line delegations plus wiring, the root
will land at **150–200 lines**. Proposed guardrail: ≤200, and every body is a one-line delegation or
a documented join (`tree`, `sessionSummary`, `preview`, `rename`, `create`, `spawnSession`). If it
exceeds 200, stop and revisit a boundary.

### Factual corrections (no answer needed, but please confirm you agree)

- **Q22's grep is stage-dependent.** After the Catalog slice, `store.ts` still uses `node:fs` for
  browse/create/archive. The SQL grep can be empty then; the full no-SQL/no-fs/no-construction grep
  only holds at the final slice. Acceptance is staged accordingly.
- **`preview` moves to the root**, not `Conversations`. It joins a row to its harness, then to a
  conversation, then to text; keeping it in `Conversations` would add the
  `Conversations → SessionRuntime` edge. Q11's closed set therefore lands as 15 methods plus task
  labelling.
- **`agentDoc` leaves `Conversations` for `Documents`** (Q17), so `Conversations` has no document
  registry dependency.
- **Notification rule:** `Catalog` notifies for the row writes it owns (insert, rename, forget,
  agent name, session model, compaction). `Compaction` delegates persistence to `Catalog` and does
  not notify again. Harness-side writes (`configure`, `fork`, `setName` when only the harness
  changes) notify from `Agents`.
- **`streams.ts` gets two small edits** before the final slice: `store.opened.has(id)` becomes
  `sessions.isOpen(id)` (slice 7), and imports/call targets are updated at the rename (slice 11).
  "Routes and streams unchanged" holds through slice 6 only.

## Interfaces

### `src/changes.ts`

```ts
export type Listener = () => void;
export class ChangeFeed {
  subscribe(fn: Listener): () => void;
  notify(): void;
}
```

### `src/locks.ts`

```ts
/** Returns a release function. Throws when a live process owns the same path. */
export function lockFile(path: string): () => void;
```

### `src/catalog.ts`

```ts
export type SessionRow = { id: string; name: string; cwd: string; dbPath: string;
  createdAt: number; model: string; provider: string };

export class Catalog {
  static open(dataDir: string, changes: ChangeFeed): Promise<Catalog>;
  readonly deviceUid: string;
  close(): Promise<void>;

  listSessions(): SessionRow[];
  getSession(id: string): SessionRow | undefined;
  resolveSession(ref: string): SessionRow;                 // throws notFound / ApiFault("ambiguous")
  insertSession(row: SessionRow, spawnKey?: string): void; // row + spawn key in one transaction
  renameSession(id: string, name: string): void;
  forgetSession(id: string): void;                         // names + row
  setSessionModel(id: string, model: ModelRef): void;

  agentNames(sessionId: string): Map<number, string>;
  setAgentName(sessionId: string, agentId: number, name: string): void;

  compactionSettings(sessionId: string): Partial<CompactionSettings> | null;
  setCompactionSettings(sessionId: string, settings: Partial<CompactionSettings> | null): void;

  replay(key: string, route: string): { status: number; body: unknown } | undefined;
  remember(key: string, route: string, status: number, body: unknown): void;

  spawnOwner(key: string): string | undefined;
  recordSpawn(key: string, sessionId: string): void;
}
```

### `src/models.ts`

```ts
export class Models {
  static open(provider: ProviderId, defaultModel?: string): Promise<Models>;
  readonly list: ModelInfo[];
  readonly defaultModelId: string;
  routed(model?: ModelRef): ModelRef;
  validate(model: unknown): ModelRef;   // throws invalid
  windowOf(modelId: string): number;
}
```

### `src/compaction.ts`

```ts
export class Compaction {
  get(sessionId: string): CompactionSettings;
  set(row: SessionRow, body: Record<string, unknown>): CompactionSettings;
  refitFor(sessionId: string, modelId: string): void; // called from Agents.configure when !compactionFits
  forget(sessionId: string): void;                   // on archive; clears the in-memory cache
}
```

### `src/documents.ts`

```ts
export const AGENT_DOC_KINDS: readonly string[];
export const DEVICE_DOC_KINDS: readonly string[];
export class Documents {
  agentDoc(h: Harness, c: Conversation, kind: string): Promise<unknown>;
  deviceDoc(kind: string): Promise<{ value: AppState; revision: number }>;
}
```

### `src/session-runtime.ts`

```ts
export class SessionRuntime {
  isOpen(sessionId: string): boolean;
  harness(row: SessionRow): Harness;               // throws unavailable
  open(row: SessionRow, create?: boolean, thinkingLevel?: ThinkingLevel): Promise<Harness>;
  archive(row: SessionRow): Promise<{ archived: string }>;
  jobs(row: SessionRow): Jobs;                     // throws unavailable
  browse(path: string): Promise<DirListing>;
  directories(): Promise<DirListing>;
  close(): Promise<void>;
}
```

`open` takes `{ catalog, models, compaction, changes, shared, spawn, createPlayground }` at
construction. The harness `settings.compaction` getter reads `compaction.get(row.id)`; it never
re-enters the runtime.

### `src/conversations.ts`

```ts
export class Conversations {
  send(c: Conversation, body: Record<string, unknown>): Promise<{ id: SubmissionId }>;
  settled(h: Harness, id: number, waitMs?: number, signal?: AbortSignal): Promise<SendResult>;
  abort(c: Conversation, background: boolean): Promise<void>;
  withdraw(h: Harness, c: Conversation, id: number): Promise<void>;
  compact(c: Conversation, instructions?: unknown): Promise<unknown>;
  reset(c: Conversation, note?: unknown): Promise<unknown>;
  tasks(h: Harness, status: string, limit: number): Promise<TaskOutcome[]>;
  abortTask(h: Harness, taskId: number): Promise<unknown>;
  inspect(h: Harness): Promise<unknown>;
  entries(c: Conversation, cursor?: string, limit?: number): Promise<Page<WireEntry>>;
  activeEntries(c: Conversation): Promise<WireEntry[]>;
  transcript(c: Conversation, format: string): Promise<unknown>;
  inbox(h: Harness, c: Conversation): Promise<InboxItem[]>;
  usage(h: Harness): Promise<UsageTotals>;
  liveTasks(h: Harness): Promise<TaskNode[]>;
  taskNode(t: unknown): TaskNode;
  labelTasks(h: Harness, nodes: TaskNode[]): Promise<TaskNode[]>;
}
```

### `src/agents.ts`

```ts
export type Resolved = { row: SessionRow; h: Harness; c: Conversation };
export class Agents {
  list(row: SessionRow, tasks?: TaskNode[]): Promise<AgentSummary[]>;
  resolve(sessionRef: string, agentRef: string): Promise<Resolved>;
  summary(row: SessionRow, c: Conversation): Promise<AgentSummary>;
  detail(row: SessionRow, c: Conversation): Promise<AgentDetail>;
  setName(row: SessionRow, agentId: number, name: unknown): void;
  create(row: SessionRow, body: { from?: unknown; name?: unknown }): Promise<AgentSummary>;
  fork(row: SessionRow, c: Conversation, body: Record<string, unknown>): Promise<AgentSummary>;
  configure(row: SessionRow, c: Conversation, body: Record<string, unknown>): Promise<AgentConfig>;
}
```

Read-only filtering reads the tool-policy view from slice 3, not a name set.

### `src/playground.ts`

```ts
export function createPlayground(shared: SharedState, sessionId: string,
  spawn: SpawnSession, jobs: Jobs): Extension;      // used by SessionRuntime.open

export class Playground {
  demoState(c: Conversation, body: Record<string, unknown>): Promise<unknown>;
  startJob(row: SessionRow, h: Harness, c: Conversation, jobs: Jobs,
    body: Record<string, unknown>): Promise<{ taskId: number }>;
  approveJob(c: Conversation, taskId: number, approved: unknown): Promise<{ ok: true }>;
}
```

## Slices

Dependency order. Each slice: new module, `Store` keeps one-line delegates for every method it still
exposes, no public method removed until slice 11. Every slice runs
`cd apps/dpi-backend && npm run check && npm test`.

| # | Slice | Files | New tests | Acceptance |
|---|---|---|---|---|
| 1 | Locks + change feed | `src/locks.ts`, `src/changes.ts` | `tests/locks.test.ts` (stale takeover, live owner refused, only owner releases) | `process.kill` leaves `store.ts`; all tests green |
| 2 | Catalog | `src/catalog.ts` | `tests/catalog.test.ts`: uid stable; insert/list/get; resolve by name and ambiguity; rename; forget removes names; spawn key round-trip; replay same route / different route; 24h GC; second open on same `dataDir` refused | `grep -nE "DatabaseSync\|\.prepare\(" src/store.ts` empty; `store.ts` ≥150 lines shorter; routes/streams diffs empty; 12 tests green |
| 3 | Tool policy (candidate 3) | `src/tool-policy.ts`, `src/extensions.ts`, `src/addons.ts`, `src/store.ts` | unit test for the policy view; `store.test.ts` read-only test asserts behaviour | `WRITE_TOOLS` gone; a tool declared `writes: true` is not offered under `readOnly`; API unchanged |
| 4 | Models | `src/models.ts` | `tests/models.test.ts` (faux routing/validation, fallback from another provider) | `loadModels`/`routedModel`/`validateModel` no longer in `store.ts` |
| 5 | Compaction | `src/compaction.ts` | `tests/compaction.test.ts` (defaults, saved values, refit when the window shrinks, forget on archive) | `compactionOf`/`setCompaction`/`windowOf` no longer in `store.ts`; `configure` calls `refitFor` |
| 6 | Documents | `src/documents.ts` | covered by existing API doc tests; add unknown-kind cases if absent | doc registry no longer exported from `store.ts`; routes/streams still unchanged |
| 7 | SessionRuntime | `src/session-runtime.ts` | `tests/session-runtime.test.ts`: create/open/close, archive keeps files, `isOpen`, unavailable harness error | `streams.ts` uses `isOpen`; `opened` not exposed; no `node:fs` in `store.ts` for session paths |
| 8 | Conversations | `src/conversations.ts` | `tests/conversations.test.ts`: send→settled, abort, inbox coercion (string/blocks/write), entries cursor round-trip, task labels | module imports none of the other new modules (takes harness/conversation arguments); `preview` still in root |
| 9 | Agents | `src/agents.ts` | extend `store.test.ts` only where a seam is new (`resolve` by name/ambiguous, read-only via policy) | agent methods leave `store.ts`; no cycle |
| 10 | Playground | `src/playground.ts` | existing `store.test.ts` demo/job tests still pass unchanged | demo endpoints move without behaviour change |
| 11 | Root + rename | `src/device.ts` (moved from `store.ts`), `main.ts`, `routes.ts`, `streams.ts`, tests | none new | `Device` ≤200 lines; `grep -nE "DatabaseSync\|\.prepare\(\|node:fs\|new Harness\|createRegistry"` empty; every body a delegation or listed join; all suites green |

### Slice 11 details

`Store` → `Device` in `src/device.ts`. Move `create`, `spawnSession`, `rename`, `preview`,
`deviceInfo`, `tree`, `sessionSummary`, `sessionSummaryBase`, `open`, `close` into it. Update
`main.ts` (`Device.open`), `routes.ts`/`streams.ts` imports and types, and the `tempStore` helper in
`tests/helpers.ts` (`tempDevice`). `API.md` must not change.

## Risks and guardrails

- **`openAgent` ordering:** `createJobs` → `createPlayground` → `Harness.open` → seed docs in
  `conversationCreated` → route stored models → `resume`. Keep it; a new doc goes in both the seeder
  and `Documents`.
- **`create` order:** open the harness first, then insert the catalog row. A failed open must not
  leave a row.
- **`archive` order:** abort every conversation → close + unlock → move directory → forget the row →
  `compaction.forget` → notify.
- **Replay semantics:** `spawnSession` returns the same session for the same key and reuses
  `${key}:prompt` as the submission request id. Keep both.
- **Compaction getter:** `settings.compaction` is read on every request; it must call
  `Compaction.get`, which caches, and must not call back into `Agents`/root.
- **Notification loops:** `notify` is synchronous; stream push is coalesced at 250 ms. Never notify
  from inside a listener.
- **Unknown handler:** a job def with no handler still fails at run time; slice 10 does not change
  that (candidate 4 handles it later).

## Final verification

```bash
cd apps/dpi-backend && npm run check && npm test
cd apps/dpi-sdk && npm run check && npm test
just test unit
git diff --stat            # expect: src/store.ts → src/device.ts plus new src modules, tests, GLOSSARY.md
grep -nE "DatabaseSync|\.prepare\(|node:fs|new Harness|createRegistry" apps/dpi-backend/src/device.ts
git diff --stat -- apps/dpi-backend/API.md   # empty
```

Manual smoke: `just test smoke faux` (TUI), then one real device session with the faux provider if
available. Confirm `/v1/device`, `/v1/tree`, create/rename/archive, one agent message, one durable
job run.

## Confirmation needed

1. **Correction A** — move `create`/`spawnSession` to the root (revising Q3) so the module graph is
   acyclic.
2. **Correction B** — accept a 150–200 line root with the "delegation or documented join" rule.
3. The four factual corrections above (staged grep, `preview` and `agentDoc` placement, notification
   ownership, `streams.ts` edits).

Say yes and I'll start with slice 1.
