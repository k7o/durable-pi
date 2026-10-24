# Device pack: plan

Status: **approved direction, nothing implemented.** The demo stays; it moves out of the device.

## Goal

`apps/dpi-backend` becomes the device only: boot, HTTP/SSE, sessions, agents, durability. The
playground demo — App State, todos, `search_history`, the four jobs, the pager, the custom addons,
the prompt, the fake model, the `/demo` routes — moves to a new `apps/dpi-demo-backend`, which
composes the device with a pack. Deleting that app must not touch anything under `apps/dpi-backend/src`.

Payoff: 4,911 lines of backend `src` become ~2,100 of device plus a demo app you can ignore, instead
of one 2,327-line demo in the middle of it. No HTTP, SSE, doc-kind, tool-name or persisted-name change,
so the hub keeps working untouched.

## Where the demo touches the device today

Seventeen imports in six files. This table is the whole coupling; nothing else crosses.

| Device file | What it reaches for | Becomes |
|---|---|---|
| `src/session-runtime.ts` | `createPlayground`, `createAddons`, `createJobs`, `JobRuns`, `Todos`, `SpawnSession`, `SharedState` | `pack.createSession({ spawn })` → `{ docs, install() }` |
| `src/documents.ts` | `Workspace`, `JobRuns`, `Todos`, `SharedState` (agent and device doc kinds) | docs come from the pack; the registry is built at `Device.open` |
| `src/device.ts` | `ExtensionSelection` (addons), `SpawnSession`, `JOB_DEFS` (device info), `Playground`, `SharedState` | `pack.info()`, `pack.routes(device)`, `pack.sessionExtensions` |
| `src/routes.ts` | `/demo/state`, `/demo/jobs`, `/demo/jobs/:id/approval` call `device.demoState/startJob/approveJob` | the demo app mounts its own router under the same prefix |
| `src/conversations.ts` | `jobDef`, `JobRuns` to title `demo.job.*` tasks | `pack.labelTask(kind)` |
| `src/models.ts` | `installFaux`, `fauxModels` | the fake model is test-only; the demo app registers it when it wants it |

## The seam

```ts
// apps/dpi-backend/src/pack.ts
export interface PackSession {
  /** Conversation documents this pack adds, in seeding order. */
  readonly docs: readonly ConversationDoc[];
  /** Extensions installed in every session before the agent picks extras. */
  install(deps: { shared: SharedState; sessionId: string }): Extension[];
}

export interface DevicePack {
  readonly name: string;
  /** Device-scoped documents (`app.shared-state`); none in the device's default pack. */
  readonly deviceDocs?: readonly DeviceDoc[];
  createSession(deps: { spawn: SpawnSession; shared: SharedState }): PackSession;
  /** Extra `/v1` routes, mounted behind the same token middleware. */
  routes?(device: Device): Router;
  /** Merged into `GET /v1/device` — this is where `jobs` comes from. */
  info?(): Record<string, unknown>;
}
```

`SpawnSession` moves to `src/spawn.ts`: creating a session is the device's ability, not the demo's.
`Device.open(options, pack = EMPTY_PACK)` accepts the pack; `main.ts` reads it from a module path in
`DPI_PACK` or defaults to empty, so the device binary can serve a bare device.

`SharedState` stays where it is physically (`chord` replicated state) but only the pack constructs it;
the device never names it.

## Layout

```
apps/dpi-demo-backend/
  package.json  tsconfig.json          same pinned deps as dpi-backend
  src/main.ts                          Device.open({ pack: demoPack }) + serve
  src/pack.ts                          DevicePack: docs, extensions, /demo routes, info
  src/playground/                      moved verbatim from apps/dpi-backend/src/playground/
  tests/                               the demo half of the current suite
apps/dpi-backend/
  src/pack.ts  src/spawn.ts            the seam
  tests/                               device half; faux becomes tests/faux.ts
```

Cross-app imports use the repo's existing relative style (`../../dpi-backend/src/device.js`), the same
way `apps/dpi-playground/tests/hub.test.ts` already imports the backend's test helpers. The demo app
gets its own `node_modules` (express, tsx, typescript, the three `@earendil-works` packages, all
pinned exactly); the registry is reachable from this sandbox.

## Slices

One commit each; gate on `cd apps/dpi-backend && npm run check && npm test` (and the demo app's own
check/test from slice 4 on).

| # | Slice | Gate |
|---|---|---|
| 0 | Snapshot the contract the split could drop: the mounted route list, `GET /v1/device` keys, agent and device doc kinds, tool names in order, job ids and phase ids. | New test fails if a route, doc kind, tool or job disappears. No production change. |
| 1 | Add `pack.ts`, `spawn.ts`, and `ConversationDoc`/`DeviceDoc` types. Move `SpawnSession`. Nothing consumes the pack yet; the demo still lives in `src/playground/`. | Types compile, no behavior change, all tests green. |
| 2 | One demo entry point: `src/playground/pack.ts` implements `DevicePack`. `device.ts` and `session-runtime.ts` take their docs, extensions, info and routes from it instead of importing feature files. `conversations.ts` uses `labelTask`. | Only `playground/pack.ts` and types cross the boundary; grep in the gate proves it. |
| 3 | `documents.ts` and `models.ts` stop naming demo modules: the doc registry is built from the pack, faux becomes `tests/faux.ts` for device tests and the demo app's own provider. | Device `src` contains no demo identifier (`Todos`, `JOB_DEFS`, `SharedState`, `AppState`, `demo`). |
| 4 | Create `apps/dpi-demo-backend` and move `src/playground/**` there with `pack.ts` and `main.ts`; move the demo half of the tests. Add `just demo dev`; keep `just backend dev` for the bare device. | Both apps' `check` and `test` pass; the hub tests still pass against the demo app. |
| 5 | Docs: `README.md`, `docs/agents/backend-map.md` (new), the tracing map in `session-runtime.ts`, and a guard test that `apps/dpi-backend/src` imports nothing from the demo app. | Guard test green; docs name the two apps. |

Slices 2 and 3 are the only risky ones: both change who owns seeding, and seeding order is a contract
(`Workspace`, `JobRuns`, `Todos`). Keep the order the pack returns as the order it is seeded in, and do
not reorder while moving.

## Contracts to preserve

- HTTP paths and SSE frame kinds, including `/v1/sessions/:s/agents/:a/demo/{state,jobs,jobs/:id/approval}`
- `GET /v1/device` shape, including `jobs` (now from `pack.info()`)
- doc kinds: `app.shared-state`, `demo.workspace`, `demo.job-runs`, `demo.todos`, `demo.todo-receipt`,
  `demo.pager`, `demo.receipt`, `ext.system-prompts`
- tool names and order, job ids and phase ids, task definition names
- the client's document subscription list — it must not need a change

## Decisions carried in

| # | Decision |
|---|---|
| Q1 | The demo leaves as a **separate app**, not a `src/demo/` folder. The user's ask, and the guard test makes the boundary enforceable. |
| Q2 | The pack is a small interface in the device, not a plugin framework: two packs exist (empty and demo). No manifests, no discovery, no config file. |
| Q3 | `SpawnSession` is the device's type. It is what a tool uses to create a session, and the device already owns session creation. |
| Q4 | The fake model is test-only in the device. The demo app may register it at runtime for offline demos, and that is the demo app's business. |
| Q5 | `just backend dev` keeps working as a bare device. A bare device has no demo routes, no docs but its own, and no agent tools. |
| Q6 | No changes to the hub until a slice proves one is needed. It is an HTTP client; if the routes are identical it does not care where they live. |

## Risks

- **Seeding order** is a contract (the client does not depend on it, but forks and run records do).
- **`ExtensionSelection`** in `device.ts` is addon state (the agent's stored extension choice). The device
  keeps the read/write path; only the extension list comes from the pack. Do not move the API surface.
- **A bare device still needs a registry**. `createRegistry()` with only `CodingTools` must be a valid
  session, or `just backend dev` boots into something that cannot answer.
- **Tests that boot a server** (`api`, `recovery`, `contracts`) exercise demo behaviour and move with the
  demo; the device's own tests must stop using `faux` for anything but the provider seam.
- **The image build** (`sbx/durable.dockerfile`, `just kit build`) bakes `apps/`. Adding an app means the
  image needs a line, or the sandboxed device keeps serving the demo from the old layout. Out of scope
  for these slices; record it as a follow-up rather than discovering it during a deploy.

## Open decision

One: does `apps/dpi-demo-backend` keep the name `playground` anywhere user-visible (the hub's title, the
extension name `playground`, the prompt)? **Recommendation:** keep the extension name and prompt
identical — they are prompt text and client-visible — and let only the directory and package name say
"demo".
