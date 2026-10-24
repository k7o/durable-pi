#!/usr/bin/env bash
# The provider matrix `durable start` resolves before it writes ~/.dpi/backend.env.
#
# No sandbox, no image, no network: `durable pick` reads the environment and prints the provider the
# device would start on. What it pins is the rule the demo pack introduced: faux is the pack's
# provider, so it is reachable only when this device has one, and a request for it without a pack
# falls back to a real provider instead of to a backend that never answers /healthz.
#
#   bash sbx/scripts/durable.test.sh      # or: just kit test
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
durable="$here/durable.sh"
fails=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pack="$tmp/pack.ts"
printf 'export default { name: "test", createSession: () => ({ docs: [], install: () => [] }) };\n' >"$pack"

# check <expected> <label> <VAR=value…>: runs `durable pick` with nothing but these variables, so a
# value inherited from the caller's shell cannot make a case pass for the wrong reason.
check() {
  local want="$1" label="$2" got
  shift 2
  got="$(env -i PATH="$PATH" HOME="$tmp/home" DPI_HOME="$tmp/home/.dpi" "$@" bash "$durable" pick 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf 'ok   %s → %s\n' "$label" "$got"
  else
    printf 'FAIL %s → %s (want %s)\n' "$label" "${got:-<empty>}" "$want"
    fails=$((fails + 1))
  fi
}

check faux "no key, demo pack" DPI_PACK="$pack"
check opencode-go "no key, no pack: boots with no models instead of exiting" DPI_PACK=
check opencode-go "faux asked for without a pack" DPI_PACK= DPI_PROVIDER=faux
check faux "faux asked for with a pack" DPI_PACK="$pack" DPI_PROVIDER=faux
check opencode-go "bad DPI_PACK path is no pack" DPI_PACK="$tmp/missing.ts"
check deepseek "requested key is bound" DPI_PACK= DPI_PROVIDER=deepseek DEEPSEEK_API_KEY=sentinel
check opencode "opencode passes through" DPI_PACK= DPI_PROVIDER=opencode OPENCODE_API_KEY=sentinel
check opencode-go "requested key is absent, the other one is bound" DPI_PACK= DPI_PROVIDER=deepseek OPENCODE_API_KEY=sentinel
check faux "no key at all, demo pack: faux is the only model access left" DPI_PACK="$pack" DPI_PROVIDER=deepseek

if [ "$fails" -gt 0 ]; then
  printf '\n%d of 9 cases failed\n' "$fails" >&2
  exit 1
fi
printf '\n9/9 cases pass\n'
