#!/usr/bin/env bash
# durable — the device, from inside its own sandbox.
#
#   durable start    ensure ~/.dpi/backend.env, then start dpi-backend unless it is already up
#   durable attach   start, then hand the terminal to dpi-tui on a session in the workspace
#   durable shell    start, then a login shell (no client)
#   durable status   print how this device is configured and how to reach it
#
# `start` is the lifecycle startup hook and runs on every boot, so it has to converge: the
# env file is rewritten each time (the token is the one thing it keeps), and the backend is
# only launched when nothing answers /healthz.
set -euo pipefail

APP_DIR=/opt/durable-pi
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
pick_provider() {
  local want="${DPI_PROVIDER:-opencode-go}"
  case "$want" in
    faux) printf 'faux'; return ;;
    opencode | opencode-go)
      if [ -n "${OPENCODE_API_KEY:-}" ]; then printf '%s' "$want"; return; fi
      ;;
    deepseek)
      if [ -n "${DEEPSEEK_API_KEY:-}" ]; then printf 'deepseek'; return; fi
      ;;
  esac
  # The requested provider has no key here. Use whichever key is bound before giving up on
  # model access entirely: a device on faux still runs, it just answers deterministically.
  if [ -n "${OPENCODE_API_KEY:-}" ]; then
    printf 'opencode-go'
  elif [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    printf 'deepseek'
  else
    printf 'faux'
  fi
}

write_env() {
  local token provider model start_dirs
  # Reading a file that may not exist yet is its own branch: with `set -e` and `pipefail`, a
  # failing `sed` in the middle of a pipeline fails the whole assignment and takes the script
  # with it, before the fallback below ever runs.
  token=""
  if [ -f "$ENV_FILE" ]; then token="$(sed -n 's/^DPI_TOKEN=//p' "$ENV_FILE" | head -1)"; fi
  [ -n "$token" ] || token="dpi_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"

  provider="$(pick_provider)"
  if [ "$provider" = faux ]; then model="${DPI_MODEL:-echo}"; else model="${DPI_MODEL:-deepseek-v4.1-flash}"; fi

  # Sessions start on the mounted workspace, so durable agents work on the user's real tree.
  start_dirs="${WORKSPACE_DIR:-}"
  if [ -z "$start_dirs" ] || [ ! -d "$start_dirs" ]; then start_dirs="$HOME/dpi-work"; fi

  mkdir -p "$start_dirs" "$DPI_HOME_DIR"
  umask 077
  {
    printf 'DPI_TOKEN=%s\n' "$token"
    printf 'DPI_DEVICE_NAME=%s\n' "${DPI_DEVICE_NAME:-$(hostname)}"
    printf 'DPI_PORT=%s\n' "$PORT"
    printf 'DPI_HOST=0.0.0.0\n'
    printf 'DPI_START_DIRS=%s\n' "$start_dirs"
    printf 'DPI_PROVIDER=%s\n' "$provider"
    printf 'DPI_MODEL=%s\n' "$model"
    # Credentials reach the container as proxy sentinels; the real keys stay on the host.
    if [ -n "${OPENCODE_API_KEY:-}" ]; then printf 'OPENCODE_API_KEY=%s\n' "$OPENCODE_API_KEY"; fi
    if [ -n "${DEEPSEEK_API_KEY:-}" ]; then printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_API_KEY"; fi
  } >"$ENV_FILE"
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
  log "starting dpi-backend on $BASE_URL (provider $(sed -n 's/^DPI_PROVIDER=//p' "$ENV_FILE"), start dir $(sed -n 's/^DPI_START_DIRS=//p' "$ENV_FILE"))"
  cd "$APP_DIR/apps/dpi-backend"
  # setsid: a long-running service belongs in its own process group, so it outlives the hook
  # that launched it and can be signaled as a unit.
  setsid node_modules/.bin/tsx src/main.ts >>"$LOG_FILE" 2>&1 &
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
    printf 'usage: durable start|attach|shell|status\n' >&2
    exit 2
    ;;
esac
