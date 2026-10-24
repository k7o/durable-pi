# Setup: hub on the host, devices in sandboxes

One hub, one frontend, N device sandboxes. The hub holds every device's token and none of your
API keys; the devices hold their own sessions and no API keys either. This is the runbook for
standing that up on a machine that already has `sbx`.

Steps 1–4 are once per machine. Steps 5–6 are once per device. Step 7 proves it works.

## 0. What runs where

```
host                                    sandbox (one per device)
  hub                :4781  ────┐        dpi-backend  :4780  (+ the playground pack)
  ~/.dpi/network.sqlite         │  token   ~/.dpi/backend.env      token
  dpi-network.yaml              └─inject──►~/.dpi/backend/          sessions, checkpoints
  sbx credential proxy ────────────────────► outbound to opencode.ai / api.deepseek.com
  OPENCODE_API_KEY / DEEPSEEK_API_KEY         (the sandbox only carries a sentinel)
```

Nothing on the host calls a model. Nothing in a sandbox holds a key.

**What a device sandbox serves.** The image carries the device (`apps/dpi-backend`: boot, HTTP/SSE,
sessions, agents, durability) and both packs: the playground demo (`apps/dpi-demo-backend`: the
workspace document, todos, the four durable jobs, the pager, the extra tools and the `/demo` routes)
and the news desk (`apps/dpi-news-backend`: `news.stories`, the `news` tool, the digest run).
`DPI_PACK` picks one **per device at boot** as `demo` (the default), `news`, `bare`, or an absolute
path to a pack module, so a sandbox is a demo device by default and a news device with
`--arg pack=news` or `DPI_PACK: news` in its environment file. A bare
device is `DPI_PACK: ""`; it keeps App State and `read_state`/`update_state` (every device has
those) and loses both packs' tools and the demo's scripted faux model.

One device serves one pack: two products on one sandbox is two sandboxes, each with its own port,
data dir and `DPI_PACK`.

## 1. Prerequisites on the host

| need | why | check |
|---|---|---|
| `sbx` 0.47 or newer | the workload declares `long-running@1`, which older builds reject | `sbx --version` |
| Docker with `buildx` | kit images are built on the host, not in a sandbox | `docker buildx version` |
| Node 22.19+ | the hub and the SDK CLI | `node --version` |
| a durable-pi checkout, on the branch with `sbx/` in it | it holds the kit, the hub and the enrollment script | `ls sbx/durable.yaml` |
| `just` + `zsh` (optional) | the repo's recipes are `zsh` scripts with `just` wrappers | `just --version` |

Every command below is written with `just` first and the raw equivalent after it, so you can skip
`just` entirely.

## 2. Build the device image

```bash
cd <checkout>
DPI_KIT_TAG=k7o/sbx-kit-durable:0.1.0 just kit build   # stage the apps, then docker buildx build
```

The tag matters later: `just kit build` defaults to `k7o/sbx-kit-durable:dev`, and step 5's
no-publish path references the image by the tag you actually built.

The raw form of the same thing — staging matters, because the descriptor's own directory is the
build context root and it cannot reach `apps/`:

```bash
rm -rf sbx/build && mkdir -p sbx/build/apps
rsync -a --exclude node_modules --exclude .data --exclude dist \
  apps/dpi-sdk apps/dpi-backend apps/dpi-demo-backend apps/dpi-tui sbx/build/apps/
docker buildx build -f sbx/durable.yaml -t k7o/sbx-kit-durable:0.1.0 sbx/
```

Expect the sandbox-kit frontend to be pulled, the descriptor to be decoded, and
`docker.io/k7o/sbx-kit-durable:0.1.0` to be produced. That build is itself the validation: if the
descriptor or a capability is wrong, it fails there rather than inside a sandbox. `just kit test`
checks the provider selection the boot script makes without building anything.

Rebuild and recreate a device after any change under `apps/` — kit content is applied at sandbox
creation only.

## 3. Install the host side

The hub serves the frontend and proxies to devices; the SDK supplies the CLI that enrollment and
status go through. Neither needs a provider key.

```bash
cd <checkout>
just install                                # npm install in dpi-sdk, dpi-backend, dpi-demo-backend, dpi-playground, dpi-tui
just hub build                              # vue-tsc + tsc + vite build of the SPA
```

Raw equivalent, if you only want the two you need:

```bash
npm ci --prefix apps/dpi-sdk
npm ci --prefix apps/dpi-playground
npm run build --prefix apps/dpi-playground
```

## 4. Declare the devices

An `url` device is register-only: the hub and the CLI need its id and URL, and its token arrives
later from `enroll.sh`. The host writes nothing into a sandbox.

```bash
cp dpi-network.example.yaml dpi-network.yaml      # gitignored
```

Edit it: drop the `local` device (the host is not a device in this topology) and add one entry per
sandbox, using the same host ports you will pin in step 6.

```yaml
defaults:
  port: 4780
  node: 24
  code_dir: ~/dpi
  home_dir: ~/.dpi
  start_dirs: ["~/dpi-work"]
  env_keys: []        # url devices are register-only. The kit writes the device's own env, and
                      # the sandbox holds only the credential proxy's sentinel, never a key.

devices:
  device-a:
    name: Device A
    kind: url
    url: http://127.0.0.1:4780
  device-b:
    name: Device B
    kind: url
    url: http://127.0.0.1:4781
```

Removing an entry prunes its row from the registry the next time the hub or the CLI syncs
(`pruneConfig`), so this file stays the source of truth.

## 5. Create the first device

### Path A — quickest, no registry, ephemeral port

```bash
cd <checkout>
just kit stage                              # sbx builds ./sbx itself, but the apps must be staged
sbx run ./sbx --name device-a               # workspace = this directory; attaches to the device TUI
```

The device serves the demo pack unless you say otherwise; `--arg pack=news` gives the news desk on
the same image, and `--arg pack=bare` gives the device with no product on it. One pack per device
either way, which is why there is no such thing as two packs on one sandbox.

Find the port it published, declare that URL, and enroll:

```bash
sbx ports device-a                          # note the host port it reports
./sbx/enroll.sh device-a device-a
```

If the port is not 4780, either use what `sbx ports` reports in `dpi-network.yaml` or recreate the
device on a pinned port with Path B.

### Path B — the reproducible shape, pinned port, enrollment automatic

One environment file, one device per invocation:

```bash
mkdir -p ~/sbx-envs/durable-dev
cp <checkout>/sbx/durable.example.sbxenv.yaml ~/sbx-envs/durable-dev/sbxenv.yaml
$EDITOR ~/sbx-envs/durable-dev/sbxenv.yaml  # set args.repo, workspace, and the device/hostPort defaults
```

The file must live **outside** the workspace it mounts: it declares a command that runs on your
host, and anything inside a writable mount can be replaced by whoever can write there — including
the agent.

```bash
sbx env plan ~/sbx-envs/durable-dev/sbxenv.yaml     # shows the plan, changes nothing
sbx env create ~/sbx-envs/durable-dev/sbxenv.yaml --name device-a --env-arg hostPort=4780 --force
sbx env create ~/sbx-envs/durable-dev/sbxenv.yaml --name device-b --env-arg hostPort=4781 --force
```

`--force` approves the plan for that invocation. Because the file contains a lifecycle command,
every `create`/`run` asks for approval otherwise; to stop being asked until the command text
changes:

```bash
sbx settings set env.rememberHostCommands true
```

Host ports are global, so each device needs its own. `ports.host` pins it and `lifecycle.postCreate`
runs `sbx/enroll.sh`, which reads the token out of the new sandbox and registers it.

The `env:` block is where the device's own configuration lives, and it is the only place that can
change it without a rebuild: `DPI_PROVIDER`, `DPI_MODEL`, `DPI_DEVICE_NAME`. Add `DPI_PACK: ""`
there to serve the bare device instead of the playground — the descriptor's startup hook names
`DPI_PACK`, so the value reaches the boot script. Do not ask for `DPI_PROVIDER: faux` with
`DPI_PACK: ""`: faux is the demo app's provider, and the boot script refuses to start on it without
a pack (`just kit test` pins that).

**The one thing to check on your host:** `kits:` in the example names a registry reference
(`k7o/sbx-kit-durable:0.1.0`), which assumes the image is pushed. If you would rather not publish:

```bash
# a) local image, if the sbx daemon shares your Docker image store
#    kits: [k7o/sbx-kit-durable:0.1.0]  +  sandboxOptions: {pullPolicy: never}
#    (the tag must be the one you built: DPI_KIT_TAG=… just kit build, default is :dev)
# b) the kit directory itself
#    kits: [<checkout>/sbx]  and set agent to whatever name sbx resolves for it
```

`sbx env plan` reports what it resolved without creating anything, so that is the place to try it.
Publishing the image (`just kit push k7o/sbx-kit-durable:0.1.0`) is the deterministic answer.

## 6. Start the hub

```bash
cd <checkout>
just hub start                              # or: DPI_HUB_PORT=4781 npm start --prefix apps/dpi-playground
```

Binding choice — the two hops are not the same:

- **Devices** are published to the host loopback. The hub runs on this host, so loopback is enough
  and nothing is exposed. If the hub cannot reach a loopback publish, fall back to
  `--publish 0.0.0.0:<host-port>:4780/tcp`; devices require their bearer token anyway.
- **The hub itself** must be reachable by your *browser*. If you browse from inside WSL,
  `DPI_HUB_HOST=127.0.0.1` (the default). If you browse from Windows against a WSL daemon, bind
  `DPI_HUB_HOST=0.0.0.0` — that is WSL-internal exposure (the WSL vNIC is NAT'd, so not LAN-reachable),
  not a public port. Do not publish the hub beyond your machine: it has no login, and reaching it
  means holding every device token.

Then open <http://127.0.0.1:4781>.

## 7. Verify

```bash
just net status                             # every declared device should read online
# raw: NODE_NO_WARNINGS=1 apps/dpi-sdk/node_modules/.bin/tsx apps/dpi-sdk/scripts/net.ts status
```

In the browser: click a device, create a session, send a turn, and watch it stream.

Then prove the three properties this architecture exists for:

```bash
# 1. no key in the sandbox — you should see a sentinel, not a key
sbx exec device-a sh -c 'grep -E "OPENCODE|DEEPSEEK" ~/.dpi/backend.env'

# 2. the device serves the playground: one line, and the path is the demo app's pack
sbx exec device-a sh -c 'grep DPI_PACK ~/.dpi/backend.env'

# 3. durability — start a turn, close the browser (or kill the hub), reopen the device
#    The agent keeps running on its own; the transcript is checkpointed in SQLite
#    (~/.dpi/backend/sessions/<uuid>/agent.sqlite) before anything is shown.
sbx exec device-a sh -c 'tail -5 ~/.dpi/backend.log'
```

## 8. Day two

| task | command |
|---|---|
| add a device | declare it in `dpi-network.yaml`, then `sbx env create … --name device-c --env-arg hostPort=4782` |
| change provider or model | edit `env:` in the env file, then `sbx env run <file>` (applies to new sessions, no recreate) |
| serve the bare device, or bring the playground back | edit `env:` in the env file — `DPI_PACK: ""` for the bare device, remove the key for the packed one — then restart the sandbox: the startup hook rewrites `~/.dpi/backend.env` at boot, and that file is where the pack is recorded |
| change ports, kits, workspace | `sbx env rm <file>` then create again — those take effect only at creation |
| recreate a device after a rebuild | same id and port; `enroll.sh` replaces the token and forgets the stale uid |
| rotate a device token | not supported for `url` devices: recreate the sandbox, or edit its `backend.env`, restart the backend, and re-enroll |
| remove a device | `sbx env rm <file> --name device-a` (or `sbx rm device-a` for `sbx run` sandboxes), then drop its entry from `dpi-network.yaml` |

## 9. Troubleshooting

| symptom | cause |
|---|---|
| hub shows no devices | nothing declared/registered: `just net status`, and check `dpi-network.yaml` resolved where you think (`net status` prints the config path) |
| device `offline` | backend not up (`sbx exec device-a tail -20 ~/.dpi/backend.log`) or its port is not published (`sbx ports device-a`) |
| device `unauthorized` | stored token is stale — re-run `./sbx/enroll.sh device-a device-a` |
| device lists 0 models | `DPI_PROVIDER` is a real provider and its key is not bound in that sandbox: the backend logs a warning at startup and runs, with nothing to offer a new session. Fix the `bindings` entry or set `DPI_PROVIDER` to a provider whose key is bound |
| device lists 0 models though the env file said `faux`, or you set `DPI_PACK: ""` | faux is the demo pack's provider, not the device's: with no pack the boot script starts on a real provider instead (`durable start` logs which). Restore `DPI_PACK` or bind a key |
| `model_error` on a turn | the sentinel reached the provider unswapped: the `bindings` entry for that service is missing or its domain is not allowed |
| hub answers `421` / `403` | its Host/origin guard: use a name from its allowlist (`localhost`, `127.0.0.1`, or the machine name) rather than an arbitrary IP or FQDN |
| `database already owned by process` | a stale backend in the sandbox still holds the lock: kill it and `durable start` |
| TUI shows `adhoc` | attached with `--url` and no `--save`; use `durable attach`, which saves under the device name |
