# dpi-demo-backend

The **demo device**: [`dpi-backend`](../dpi-backend) plus the playground pack. It owns everything demo-specific —
App State, the todo list, `search_history`, the pager, the four durable jobs, the two custom extensions, the playground
prompt, the fake model and the three `/demo` routes — so the device's `src/` stays the device.

```bash
cd apps/dpi-demo-backend && npm install
just demo dev          # http://127.0.0.1:4780 with DPI_PROVIDER=faux if no key is set (see below)
```

It reads the same `~/.dpi/backend.env` as the device and takes the same flags (`just backend token` creates the file).
`DPI_PROVIDER=faux` gives the free deterministic model with no key; any other provider needs its key, exactly as the
device does. `just backend dev` runs the bare device on the same port, so run one at a time.

## What it adds to the device

| | |
|---|---|
| **Conversation documents** | `demo.workspace`, `demo.job-runs`, `demo.todos` (`+ demo.todo-receipt`), seeded in that order |
| **Device document** | `app.shared-state`, in `app-state.sqlite`, opened, locked and served by the device; the pack seeds the keys it owns (`goal`, `counter`, `notes`) |
| **Agent tools** | `todo`, `list_durable_jobs`, `run_durable_job`, `check_durable_job`, `search_history`, `ping_on_call_engineer`, `subagent`, `start_session`, `handoff` (the device adds `read_state` and `update_state`) |
| **Custom extensions** | `system-prompts` (a checklist of the prompts in `prompts/`) and `jev-damage-control` (Jev judges every bash command; off by default) |
| **Durable jobs** | `workspace-snapshot`, `release-check`, `change-watch`, `todo-digest` |
| **Routes** | `POST .../agents/:a/demo/{state,jobs,jobs/:taskId/approval}` |
| **`GET /v1/device`** | `jobs`, and the `demo`/`jobs` capabilities |

The seam is [`apps/dpi-backend/src/pack.ts`](../dpi-backend/src/pack.ts). The demo app imports the device's modules
directly; the device never imports this app. [`docs/agents/backend-map.md`](../../docs/agents/backend-map.md) has the
full map and [the device pack plan](../../docs/agents/device-pack.md) records why the split happened.

## Tests

```bash
npm run check    # strict types
npm test         # api, streams, recovery, contracts, jobs, extensions, search_history, shared state
```

These tests boot the real binary with the faux provider, so they are free and offline. The device's own tests live in
[`../dpi-backend/tests`](../dpi-backend/tests) and exercise the device alone.
