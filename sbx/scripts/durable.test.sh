#!/usr/bin/env bash
# The provider matrix and the pack `durable start` resolves before it writes ~/.dpi/backend.env.
#
# No sandbox, no image, no network: `durable pick` reads the environment and prints the provider the
# device would start on, and `durable pack` prints the pack module it would serve. What they pin is
# the rule the demo pack introduced — faux is the pack's provider, so it is reachable only when this
# device has one, and a request for it without a pack falls back to a real provider instead of to a
# backend that never answers /healthz — plus the shorthand the descriptor's `pack` argument uses:
# `demo`, `news`, `bare`, or a path, resolved against a fake image root here.
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
# A stand-in image root: the script resolves `demo` and `news` to these paths, which is the whole
# point of the names, and the real ones do not exist outside a sandbox.
for name in demo news; do
  mkdir -p "$tmp/app/apps/dpi-$name-backend/src"
  cp "$pack" "$tmp/app/apps/dpi-$name-backend/src/pack.ts"
done
cases=0

# check <expected> <label> <VAR=value…>: runs `durable pick` with nothing but these variables, so a
# value inherited from the caller's shell cannot make a case pass for the wrong reason.
check() {
  local want="$1" label="$2" got
  shift 2
  cases=$((cases + 1))
  got="$(env -i PATH="$PATH" HOME="$tmp/home" DPI_HOME="$tmp/home/.dpi" "$@" bash "$durable" pick 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf 'ok   %s → %s\n' "$label" "$got"
  else
    printf 'FAIL %s → %s (want %s)\n' "$label" "${got:-<empty>}" "$want"
    fails=$((fails + 1))
  fi
}

# checkpack <expected> <label> <VAR=value…>: the pack path the same variables resolve to.
checkpack() {
  local want="$1" label="$2" got
  shift 2
  cases=$((cases + 1))
  got="$(env -i PATH="$PATH" HOME="$tmp/home" DPI_HOME="$tmp/home/.dpi" DPI_APP_DIR="$tmp/app" \
    "$@" bash "$durable" pack 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf 'ok   %s → %s\n' "$label" "${got:-<none>}"
  else
    printf 'FAIL %s → %s (want %s)\n' "$label" "${got:-<none>}" "${want:-<none>}"
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

checkpack "$tmp/app/apps/dpi-demo-backend/src/pack.ts" "pack unset defaults to demo"
checkpack "$tmp/app/apps/dpi-demo-backend/src/pack.ts" "pack=demo" DPI_PACK=demo
checkpack "$tmp/app/apps/dpi-news-backend/src/pack.ts" "pack=news" DPI_PACK=news
checkpack "" "pack=bare is no pack" DPI_PACK=bare
checkpack "" "pack= (empty) is no pack" DPI_PACK=
checkpack "$pack" "a path passes through" DPI_PACK="$pack"
checkpack "" "a name the image does not have is no pack" DPI_PACK=todos

if [ "$fails" -gt 0 ]; then
  printf '\n%d of %d cases failed\n' "$fails" "$cases" >&2
  exit 1
fi
printf '\n%d/%d cases pass\n' "$cases" "$cases"
