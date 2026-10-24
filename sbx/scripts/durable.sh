#!/usr/bin/env bash
# durable — the device, from inside its own sandbox.
#
#   durable start    ensure ~/.dpi/backend.env, then start dpi-backend unless it is already up
#   durable attach   start, then hand the terminal to dpi-tui on a session in the workspace
#   durable shell    start, then a login shell (no client)
#   durable status   print how this device is configured and how to reach it
#   durable pick     print the provider these environment variables resolve to, and nothing else
#   durable pack     print the pack module this device serves, or nothing on a bare device
#   durable env      print the settings `start` would write to ~/.dpi/backend.env
#
# `start` is the lifecycle startup hook and runs on every boot, so it has to converge: the
# env file is rewritten each time (the token is the one thing it keeps), and the backend is
# only launched when nothing answers /healthz.
set -euo pipefail

APP_DIR="${DPI_APP_DIR:-/opt/durable-pi}"
DPI_HOME_DIR="${DPI_HOME:-$HOME/.dpi}"
ENV_FILE="$DPI_HOME_DIR/backend.env"
PID_FILE="$DPI_HOME_DIR/backend.pid"
LOG_FILE="$DPI_HOME_DIR/backend.log"
PORT="${DPI_PORT:-4780}"
BASE_URL="http://127.0.0.1:${PORT}"
SETTLE_SECONDS=30

log() { printf '[durable] %s\n' "$*" >&2; }

# The published port forwards to the container's eth0, so the backend cannot bind loopback
# alone. 0.0.0.0 inside the sandbox VM is still sandbox-only until the host publishes the port.

# The pack this device serves, if it has one. The image ships both packs, so `DPI_PACK` names one:
# `demo` (the default), `news`, or `bare`/empty for the device with no product on it. An absolute
# path is taken as it stands, which is what an environment file writes and what the descriptor's
# `pack` argument turns into — the names are a shorthand for the CLI, not a second contract.
#
# The provider choice depends on this, because `faux` is the pack's provider, not the device's.
pack_path() {
  local want="${DPI_PACK-demo}" pack
  case "$want" in
    "") return ;;
    bare | none) return ;;
    demo) pack="$APP_DIR/apps/dpi-demo-backend/src/pack.ts" ;;
    news) pack="$APP_DIR/apps/dpi-news-backend/src/pack.ts" ;;
    *) pack="$want" ;;
  esac
  if [ -f "$pack" ]; then
    printf '%s' "$pack"
  else
    log "DPI_PACK=$want names no pack in this image; this device serves none"
  fi
}

# What to call this device's pack in a log line: the app directory it lives in (`dpi-news-backend`),
# or `bare`. Parsing it back out of the env file got the last path segment instead, so the log said
# "pack src" for every device.
pack_label() {
  local pack
  pack="$(pack_path)"
  if [ -n "$pack" ]; then basename "$(dirname "$(dirname "$pack")")"; else printf 'bare'; fi
}

pick_provider() {
  local want="${DPI_PROVIDER:-opencode-go}" pack
  pack="$(pack_path)"
  # A bare device refuses `DPI_PROVIDER=faux` at startup: faux is the demo app's provider. Asking
  # for it without a pack falls through to a real provider, which boots with an empty model list
  # and a warning, rather than to a backend that never answers /healthz.
  if [ "$want" = faux ] && [ -z "$pack" ]; then
    log "DPI_PROVIDER=faux needs a pack and this device has none; starting on a real provider instead"
    want=opencode-go
  fi
  case "$want" in
    faux) printf 'faux'; return ;;
    opencode | opencode-go)
      if [ -n "${OPENCODE_API_KEY:-}" ]; then printf '%s' "$want"; return; fi
      ;;
    deepseek)
      if [ -n "${DEEPSEEK_API_KEY:-}" ]; then printf 'deepseek'; return; fi
      ;;
  esac
  # The requested provider has no key here. Use whichever key is bound, then faux if a pack can
  # serve it, and otherwise boot on a real provider with no key: the backend warns and lists no
  # models, which is diagnosable, where exiting is not.
  if [ -n "${OPENCODE_API_KEY:-}" ]; then
    printf 'opencode-go'
  elif [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    printf 'deepseek'
  elif [ -n "$pack" ]; then
    printf 'faux'
  else
    printf 'opencode-go'
  fi
}

# Sessions start on the mounted workspace, so durable agents work on the user's real tree.
start_dirs_path() {
  local start_dirs="${WORKSPACE_DIR:-}"
  if [ -z "$start_dirs" ] || [ ! -d "$start_dirs" ]; then start_dirs="$HOME/dpi-work"; fi
  printf '%s' "$start_dirs"
}

# The device's settings, one assignment per line. This is the whole configuration the backend
# process gets, which is why the pack is resolved here and not by whatever launched the hook: the
# hook's environment carries the descriptor's shorthand (`DPI_PACK=news`), and a backend handed
# that would try to import a module called "news".
env_body() {
  local token provider model start_dirs pack
  # Reading a file that may not exist yet is its own branch: with `set -e` and `pipefail`, a
  # failing `sed` in the middle of a pipeline fails the whole assignment and takes the script
  # with it, before the fallback below ever runs.
  token=""
  if [ -f "$ENV_FILE" ]; then token="$(sed -n 's/^DPI_TOKEN=//p' "$ENV_FILE" | head -1)"; fi
  [ -n "$token" ] || token="dpi_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"

  provider="$(pick_provider)"
  if [ "$provider" = faux ]; then model="${DPI_MODEL:-echo}"; else model="${DPI_MODEL:-deepseek-v4.1-flash}"; fi

  start_dirs="$(start_dirs_path)"
  {
    printf 'DPI_TOKEN=%s\n' "$token"
    printf 'DPI_DEVICE_NAME=%s\n' "${DPI_DEVICE_NAME:-$(hostname)}"
    printf 'DPI_PORT=%s\n' "$PORT"
    printf 'DPI_HOST=0.0.0.0\n'
    printf 'DPI_START_DIRS=%s\n' "$start_dirs"
    # The pack this device serves, as a resolved path, and written even when it is empty: the file
    # is the backend's whole environment, so "no pack" has to be stated or an inherited DPI_PACK
    # would survive it.
    printf 'DPI_PACK=%s\n' "$(pack_path)"
    printf 'DPI_PROVIDER=%s\n' "$provider"
    printf 'DPI_MODEL=%s\n' "$model"
    # Credentials reach the container as proxy sentinels; the real keys stay on the host.
    if [ -n "${OPENCODE_API_KEY:-}" ]; then printf 'OPENCODE_API_KEY=%s\n' "$OPENCODE_API_KEY"; fi
    if [ -n "${DEEPSEEK_API_KEY:-}" ]; then printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY"; fi
  }
}

write_env() {
  mkdir -p "$(start_dirs_path)" "$DPI_HOME_DIR"
  umask 077
  env_body >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

healthy() { curl -fsS --max-time 3 "$BASE_URL/healthz" >/dev/null 2>&1; }

wait_healthy() {
  local i
  for i in $(seq 1 $((SETTLE_SECONDS * 2))); do
    if healthy; then return 0; fi
    sleep 0.5
  done
  log "dpi-backend did not answer $BASE_URL/healthz within ${SETTLE_SECONDS}s"
  log "last lines of $LOG_FILE:"
  tail -n 20 "$LOG_FILE" >&2 2>/dev/null || true
  return 1
}

start() {
  if healthy; then
    return 0
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "backend process is up but not answering yet; waiting"
    wait_healthy
    return 0
  fi

  write_env
  log "starting dpi-backend on $BASE_URL (pack $(pack_label), provider $(sed -n 's/^DPI_PROVIDER=//p' "$ENV_FILE"), start dir $(sed -n 's/^DPI_START_DIRS=//p' "$ENV_FILE"))"
  cd "$APP_DIR/apps/dpi-backend"
  # setsid: a long-running service belongs in its own process group, so it outlives the hook
  # that launched it and can be signaled as a unit.
  # The file is the device's configuration and the hook's environment is not: it can carry the
  # descriptor's shorthand, which the backend would try to import as a module path. `set -a` plus a
  # subshell makes the file win over anything inherited, and `exec` keeps $! the process to signal.
  (
    set -a
    # shellcheck disable=SC1090 # the path is this device's own file
    . "$ENV_FILE"
    exec setsid node_modules/.bin/tsx src/main.ts
  ) >>"$LOG_FILE" 2>&1 &
  printf '%s\n' "$!" >"$PID_FILE"
  wait_healthy
}

device_token() { sed -n 's/^DPI_TOKEN=//p' "$ENV_FILE" | head -1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H "Authorization: Bearer $(device_token)" -H 'content-type: application/json' -d "$body" "$BASE_URL$path"
  else
    curl -fsS -X "$method" -H "Authorization: Bearer $(device_token)" "$BASE_URL$path"
  fi
}

# A fresh device has no sessions; create one in the workspace so `attach` lands somewhere useful.
ensure_session() {
  local existing provider model
  existing="$(api GET /v1/sessions | jq -r '.[0].name // empty' 2>/dev/null || true)"
  if [ -n "$existing" ]; then
    printf '%s' "$existing"
    return
  fi
  provider="$(sed -n 's/^DPI_PROVIDER=//p' "$ENV_FILE")"
  model="$(api GET /v1/device | jq -r '.defaultModel')"
  api POST /v1/sessions "$(jq -nc --arg p "$provider" --arg m "$model" '{name: "main", cwd: ".", model: {provider: $p, modelId: $m}}')" >/dev/null
  log "created session main in $(sed -n 's/^DPI_START_DIRS=//p' "$ENV_FILE")"
  printf 'main'
}

status() {
  local name provider model
  name="$(sed -n 's/^DPI_DEVICE_NAME=//p' "$ENV_FILE")"
  provider="$(sed -n 's/^DPI_PROVIDER=//p' "$ENV_FILE")"
  model="$(sed -n 's/^DPI_MODEL=//p' "$ENV_FILE")"
  cat >&2 <<EOF

  Durable Pi device "$name"
    provider     $provider
    model        $model
    workspace    $(sed -n 's/^DPI_START_DIRS=//p' "$ENV_FILE")
    api          $BASE_URL  (published to the host by the sandbox's port@1 entry)
    token        $ENV_FILE (mode 600; never printed)
    log          $LOG_FILE
    sessions     $(api GET /v1/sessions | jq -r 'length' 2>/dev/null || echo "?")

  Attach a client:  durable attach        (dpi-tui, in this sandbox)
  A shell:          durable shell
  Register with a hub from the host:  ./sbx/enroll.sh <device-id> <sandbox-name>
EOF
}

attach() {
  start
  if [ ! -t 0 ]; then
    # Headless launch (sbx create): no terminal to hand over, and long-running@1 is what keeps
    # the device up. Report and exit rather than blocking a TTY-less session.
    status
    return 0
  fi
  local session
  session="$(ensure_session)"
  cd "$APP_DIR/apps/dpi-tui"
  # --save also records this device in ~/.dpi/network.sqlite under its own name, so a later
  # `dpi-tui <device>` finds it without the URL and token again.
  exec node_modules/.bin/tsx src/main.ts --url "$BASE_URL" --token "$(device_token)" \
    --save "$(sed -n 's/^DPI_DEVICE_NAME=//p' "$ENV_FILE")" --session "$session"
}

case "${1:-attach}" in
  start) start ;;
  attach) attach ;;
  # The provider and the pack this environment resolves to, without starting anything: what the
  # test drives.
  pick) pick_provider ;;
  pack) printf '%s\n' "$(pack_path)" ;;
  env) env_body ;;
  shell)
    start
    cd "${WORKSPACE_DIR:-$HOME}"
    exec bash -l
    ;;
  status)
    start
    status
    ;;
  *)
    printf 'usage: durable start|attach|shell|status|pick|pack|env\n' >&2
    exit 2
    ;;
esac
