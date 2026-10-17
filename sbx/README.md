# sbx workload: a Durable Pi device

One sandbox, one device. The image carries `dpi-backend` (the device server that owns durable
sessions, tools and checkpoints in SQLite) and `dpi-tui` (the terminal client that attaches to
it). The descriptor asks the host to keep the sandbox running with no client attached, so
closing the terminal or restarting the backend does not end a run.

## Why this shape

It is a **v3 workload**, not a v2 mixin on an agent kit, and the difference is not cosmetic. A v2
sandbox kit is built around `entrypoint[0]` being an agent binary (`pi`, `herdr`). A device has no
such binary: its agent lives inside the backend process and the surface you talk to is an HTTP
API. v2 therefore forces a fiction — an entrypoint whose real job is to not exit — while v3 has
the primitive the case actually needs, `com.docker.sandbox/long-running@1`.

It lives in this repo rather than the pi kits repo because the image is built from this source
tree and every contract the kit encodes (port 4780, `DPI_PROVIDER`, `~/.dpi/backend.env`, the
token) is defined here. It sits on its own branch, off the branch carrying the provider work, so
the app patch stays a clean reviewable diff; upstream has no interest in your deployment.

```
upstream/main
└── feat/model-providers     app patch (provider selection) — reviewable
    └── deploy/sbx           this kit — never PR'd
```

## Build and run

Needs `docker buildx` on this machine and `sbx` **0.47 or newer** for `long-running@1`.

```bash
just kit check                 # sbx kit validate ./sbx
just kit build                 # stage the apps, build k7o/sbx-kit-durable:dev
just kit run durable-dev       # stage, then create a sandbox on this checkout
just kit push k7o/sbx-kit-durable:0.1.0   # publish, so an environment file can reference it
```

`just kit stage` copies `apps/{dpi-sdk,dpi-backend,dpi-tui}` into `sbx/build` (gitignored) first,
because the descriptor's own directory is the build context root and the recipe cannot reach
outside it. That is what keeps the image built from the branch you are standing on rather than
from a ref that has to be pushed and kept in sync.

`sbx run` mounts the current directory as the workspace, so durable sessions start on your tree.
Inside the sandbox:

```bash
durable status      # provider, model, workspace, session count, log path
durable attach      # dpi-tui on a session in the workspace
durable shell       # a login shell in the workspace
```

## Wiring it into a network

A kit turns one sandbox into one device. Joining that device to a network means moving its token
across the sandbox boundary, which only the host can do:

1. Declare the device in `dpi-network.yaml` (gitignored) as `kind: url`, with the URL you will
   reach it at — `http://127.0.0.1:<host-port>` for a hub on the host,
   `http://host.docker.internal:<host-port>` for a hub in another sandbox.
2. Publish its port on the host if the kit's ephemeral mapping is not enough:
   `sbx ports <sandbox> --publish 0.0.0.0:4780:4780/tcp`.
3. `just kit enroll <device-id> <sandbox>` — reads the token with `sbx exec` and registers it in
   `~/.dpi/network.sqlite`.

[`durable.example.sbxenv.yaml`](durable.example.sbxenv.yaml) does 1 and 3 declaratively: `ports:`
pins host and `hostIP`, and `lifecycle.postCreate` runs `enroll.sh` after the sandbox exists.
Copy it, point `workspace` at your repo, and `sbx env create` instead of `sbx run`.

## What it does not include

- **The web hub.** One hub is meant to front many devices, so running one per device sandbox is
  the wrong topology. Run it on the host, or in its own sandbox, and enroll devices into it. The
  hub's Host guard allowlists the port it was started with, so publish it on the port it listens
  on rather than relying on the environment file's ephemeral mapping.
- **A model provider of its own.** Credentials come from the sandbox's bindings: `opencode` and
  `deepseek` are declared optional because a device runs on either, and on `faux` with neither.
  `DPI_PROVIDER` picks one; if its key is not bound, the boot script falls back to whichever key
  is, and to `faux` if neither is. This workload needs the provider-selection patch from the
  parent branch — on upstream's `main` the backend is OpenRouter-only.
- **Anything published.** The image is built locally. Pushing it to a registry is what makes
  `kits: [k7o/sbx-kit-durable:0.1.0]` in an environment file resolvable, and what lets CI rebuild
  it later.
