# Backend map

Two apps, one device. Start here when you are looking for a file in the backend split.

```
apps/dpi-backend/          the device only
apps/dpi-demo-backend/     the device + the playground pack (workspace doc, todos, jobs, pager, prompt, /demo)
```

`dpi-backend` builds and runs on its own. `dpi-demo-backend` imports the device's `src/` directly (`../../dpi-backend/src/...`);
nothing in the device imports the demo app, and `apps/dpi-backend/tests/layout.test.ts` fails if that changes.
Deleting `apps/dpi-demo-backend` breaks only its own tests and the suites that boot it (`hub.test.ts`, `network-ui.mjs`,
`smoke.sh`).

## The seam

`src/pack.ts` is the whole contract. A pack supplies:

| Member | What it is | Demo app's answer |
|---|---|---|
| `docs` | conversation documents, in seeding order | `demo.workspace`, `demo.job-runs`, `demo.todos` |
| `deviceDocs` | device-scoped documents | `app.shared-state` |
| `open` / `close` | the pack's contribution to the device's stores | seeds the App State keys the pack owns; the device opens and locks `app-state.sqlite` and tells the change feed |
| `createSession({ spawn })` | per-session extensions, in install order | the one `playground` extension (11 tools) |
| `sessionExtensions` | custom extensions, installed unselected | `system-prompts`, `jev-damage-control` |
| `routes(device)` | extra `/v1` routes, behind the token | `POST .../demo/state`, `.../demo/jobs`, `.../demo/jobs/:taskId/approval` |
| `info()` | fields merged into `GET /v1/device` | `jobs`, and the `demo`/`jobs` capabilities |
| `labelTask(task, h)` | title a task the pack owns | `demo.job.*` runs → `Release check #2` |

`EMPTY_PACK` is the bare device: no documents, no extra extensions, no extra routes, `["events", "docs"]` capabilities.
`src/main.ts` takes a pack path from `DPI_PACK`; the demo app passes `createDemoPack()` in code.

## Where a request goes

```
routes.ts / streams.ts       HTTP v1 and SSE; a session ref and an agent ref become objects here
  device.ts                  composition root: joins across modules, no SQL, no fs, no harness
    agents.ts                resolve, list, create, fork, configure, agent projections
    conversations.ts         send, abort, withdraw, entries, transcript, tasks, task labels
    extensions.ts            which custom extensions an agent selected
    documents.ts             GET .../docs/:kind, and the one seeding list (from the pack)
    session-runtime.ts       one Harness per open session; installs the pack's extensions
      harness                pi-durable: entries, documents, tasks and submissions, one commit each
        pack tools           a tool runs in its own task and commits its effect before answering
    models.ts                one provider per device, the curated picker list, routing, validation
    catalog.ts               device uid, sessions, agent names, idempotency keys, compaction thresholds
    compaction.ts            per-session thresholds
    changes.ts               the change feed the streams coalesce
    locks.ts                 one process per data dir and per session database
    serve.ts                 express + bearer auth + v1 + shutdown (both apps use it)
```

## The demo app

```
src/main.ts                  loadConfig → Models.open or fauxModels → Device.open(demoPack) → serve
src/pack.ts                  the DevicePack implementation
src/faux.ts                  the deterministic offline model (DPI_PROVIDER=faux)
src/playground/pack.ts       ...is the pack; this table is the rest of src/playground/
  playground.ts              the assembler: features in, the one `playground` extension out
  addons.ts                  system-prompts and jev-damage-control
  features/app-state/        the workspace document the pack seeds from App State
  demo.ts                    the three /demo use cases (also used by its tests)
  features/                  app-state, todos, jobs, history, sessions, side-effects
  prompt.ts  history.ts  jev.ts
tests/                       the demo half of the suite, plus helpers that boot the real binary
```

## Contracts the split preserves

HTTP paths and SSE frames, `GET /v1/device` keys (including `jobs`), doc kinds (`app.shared-state`, `demo.workspace`,
`demo.job-runs`, `demo.todos`, `demo.todo-receipt`, `demo.pager`, `demo.receipt`, `ext.system-prompts`), tool names and
their order, job ids and phase ids, task definition names, and the client's document subscription list. The demo
contract snapshot is `apps/dpi-demo-backend/tests/contracts.test.ts`; it fails before the prompt cache does.

## Commands and gates

```bash
just backend dev     # bare device on :4780
just demo dev        # demo device on :4780
just demo check      # demo types + tests
just check           # every app
```

A change to the device runs `cd apps/dpi-backend && npm run check && npm test`. A change that touches the demo, or the
seam, also runs `cd apps/dpi-demo-backend && npm run check && npm test`.
