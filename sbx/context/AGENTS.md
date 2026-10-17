## This sandbox is a Durable Pi device

The sandbox runs `dpi-backend`, so the agents here are durable: a run survives a closed client
and a restarted backend because every checkpoint lands in SQLite before anything is shown. The
durable agent's tools (`read`, `write`, `edit`, `bash`) work on the mounted workspace, which is
the user's own tree.

### Layout

- `/opt/durable-pi/apps/{dpi-sdk,dpi-backend,dpi-tui}` — the checkout this image was built from
- `~/.dpi/backend.env` — device token (mode 600), provider, model, start dirs
- `~/.dpi/backend/` — `catalog.sqlite`, `app-state.sqlite`, `sessions/<uuid>/agent.sqlite`
- `~/.dpi/backend.log` — backend output
- the workspace mounts at `/home/agent/workspace`, and sessions start there

### Commands

```bash
durable status                 # provider, model, workspace, sessions, log
durable attach                 # dpi-tui on a session in the workspace
durable shell                  # a shell in the workspace
tail -f ~/.dpi/backend.log     # what the backend is doing
```

`durable start` runs on every boot and is idempotent: it rewrites `~/.dpi/backend.env`, keeping
the token, and starts the backend only when nothing answers `/healthz`. The token is the device's
only credential; treat it like one and do not print it.

### Driving this device from outside

The device keeps running when the last client disconnects, so an external hub or `dpi-tui` can
attach later. From the host:

```bash
sbx ports <sandbox> --publish 0.0.0.0:4780:4780/tcp     # or read the mapping sbx published
```

Then register it with a hub from the durable-pi checkout: `./sbx/enroll.sh <device-id> <sandbox>`
declares a `kind: url` device and copies the token into `~/.dpi/network.sqlite` there.

### If the model calls fail

`opencode.ai` (or `api.deepseek.com`) must be in the sandbox's network policy, and the matching
key must be bound to the sandbox. `durable status` shows the provider in use; the backend log
shows the provider's error verbatim. A device with no bound key starts on `faux`, a deterministic
model that needs no network — useful for checking the plumbing without spending anything.
