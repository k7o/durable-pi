#!/usr/bin/env bash
# Host side of the device kit: copy one device's bearer token out of its sandbox and into the
# hub registry on this machine.
#
#   ./sbx/enroll.sh <device-id> <sandbox-name>
#
# This is the step no kit can do. A kit turns one sandbox into one device and generates that
# device's token inside it; joining a device to a network means moving the token across a
# sandbox boundary, which is a host-side act. Run it from the durable-pi checkout, or from an
# environment file's lifecycle.postCreate hook, which passes $SBX_SANDBOX_NAME.
#
# The device has to be declared in dpi-network.yaml as `kind: url` first — the URL is a choice
# (which host port you published, and whether the hub reaches it as 127.0.0.1 or
# host.docker.internal) and this script will not guess it. When the id is missing, the script
# prints what to add and exits 0, so a postCreate hook never fails a create over it.
#
# Re-running is safe: register replaces the stored token and forgets the old device uid, which
# is what a recreated sandbox needs (new token, new identity, same device id).
set -euo pipefail

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  printf 'usage: sbx/enroll.sh <device-id> <sandbox-name>\n' >&2
  exit 2
fi

id="$1"
sandbox="$2"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
network_file="${DPI_NETWORK_FILE:-$root/dpi-network.yaml}"

if [ ! -f "$network_file" ]; then
  printf 'enroll: %s does not exist; nothing to register into\n' "$network_file" >&2
  exit 0
fi

if ! grep -qE "^  ${id}:" "$network_file"; then
  printf '%s\n' \
    "enroll: ${id} is not declared in ${network_file}. Add it, then re-run:" \
    "" \
    "  devices:" \
    "    ${id}:" \
    "      kind: url" \
    "      url: http://127.0.0.1:<host-port>     # or http://host.docker.internal:<host-port> when the hub runs in another sandbox" \
    "" \
    "and publish the device's port on the host. The hub runs on this host, so loopback is enough:" \
    "" \
    "  sbx ports ${sandbox} --publish 4780:4780/tcp" \
    "" \
    "Use --publish 0.0.0.0:<host-port>:4780/tcp only if the hub cannot reach the loopback publish." >&2
  exit 0
fi

# The token lives in the device's own ~/.dpi/backend.env, mode 600. Read it over the sandbox
# boundary without echoing it anywhere else.
token="$(sbx exec "$sandbox" sh -c 'sed -n "s/^DPI_TOKEN=//p" "$HOME/.dpi/backend.env"' | tr -d '\r\n')"
if [ "${#token}" -lt 32 ]; then
  printf 'enroll: no token in %s:~/.dpi/backend.env (is the backend up? try `sbx exec %s durable status`)\n' "$sandbox" "$sandbox" >&2
  exit 1
fi

cd "$root"

# Prefer the checkout's own tsx so enrollment works offline and without npx's cache.
tsx=""
for candidate in apps/dpi-sdk/node_modules/.bin/tsx apps/proactive-dpi-demo/node_modules/.bin/tsx; do
  if [ -x "$root/$candidate" ]; then tsx="$root/$candidate"; break; fi
done
if [ -z "$tsx" ] && ! command -v npx >/dev/null; then
  printf 'enroll: no tsx in %s (run `npm ci` in apps/dpi-sdk) and no npx on PATH\n' "$root" >&2
  exit 1
fi
net() {
  if [ -n "$tsx" ]; then NODE_NO_WARNINGS=1 "$tsx" apps/dpi-sdk/scripts/net.ts "$@"; else NODE_NO_WARNINGS=1 npx --yes tsx apps/dpi-sdk/scripts/net.ts "$@"; fi
}

net register "$id" --token "$token"
# Status is informational: at postCreate time the device may still be booting, and net status
# exits 2 for anything not yet online, which would fail the sandbox create.
net status "$id" || true
