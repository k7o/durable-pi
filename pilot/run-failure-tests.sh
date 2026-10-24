#!/usr/bin/env bash
# The pilot's acceptance criteria, run against a killed process.
#
#   ./run-failure-tests.sh          # build, start emulator + host, run every test
#   BASE=http://127.0.0.1:5099 ./run-failure-tests.sh
#
# Each test starts its own run with a fresh key, so reruns are independent.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:5099}"
HOST_LOG="${HOST_LOG:-/tmp/pilot-host.log}"
FIX_DIR=/tmp/pilot-fix
DEPLOY_DIR=/tmp/pilot-deploy
SUFFIX="$(date +%s)"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); say "  PASS  $*"; }
no() { FAIL=$((FAIL + 1)); say "  FAIL  $*"; }

host_pid() { pgrep -f 'net10.0/Pilot.AgentHost' | head -1; }

# Start the compiled apphost, not `dotnet run`: MSBuild evaluation on every start costs
# ~35s and this script restarts the host five times.
APP_BIN="$(cd "$(dirname "$0")" && pwd)/src/Pilot.AgentHost/bin/Debug/net10.0/Pilot.AgentHost"

start_host() {
    env ${HOST_ENV:-} nohup "$APP_BIN" --urls "$BASE" >>"$HOST_LOG" 2>&1 &
    for _ in $(seq 1 120); do
        curl -sS --max-time 1 "$BASE/health" >/dev/null 2>&1 && return 0
        sleep 0.25
    done
    say "host did not come up; see $HOST_LOG"
    return 1
}

kill_host() {
    local pid
    pid="$(host_pid)"
    [ -n "$pid" ] || return 0
    kill -9 "$pid" 2>/dev/null
    for _ in $(seq 1 20); do
        [ -z "$(host_pid)" ] && return 0
        sleep 0.25
    done
}

start_run() { # $1 run key -> run id
    curl -sS -X POST "$BASE/runs" -H 'content-type: application/json' \
        -d "{\"run_key\":\"$1\",\"incident\":\"guest checkout 500s\"}" >/dev/null
    printf 'run-%s' "$1"
}

approve() {
    curl -sS -o /dev/null -X POST "$BASE/runs/$1/approvals" \
        -H 'content-type: application/json' -d '{"approved":true,"feedback":"ship it"}'
}

field() { # $1 run id, $2 jq-ish python expr over the object
    curl -sS --max-time 5 "$BASE/runs/$1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
s=d.get('status') or {}
print($2)
" 2>/dev/null
}

wait_phase() { # $1 run id, $2 phase, $3 seconds
    for _ in $(seq 1 "$3"); do
        [ "$(field "$1" "s.get('phase','')")" = "$2" ] && return 0
        sleep 1
    done
    return 1
}

stamp() { date +%T; }

say "== build == $(stamp)"
(cd "$(dirname "$0")" && dotnet build src/Pilot.AgentHost 2>&1 | grep -E 'Build succeeded|error' | sort -u) || exit 1

say "== emulator =="
docker start dtsemulator >/dev/null 2>&1 \
    || docker run -d --name dtsemulator -p 8080:8080 -p 8082:8082 \
        mcr.microsoft.com/dts/dts-emulator:latest >/dev/null || exit 1

say "== host =="
kill_host
start_host || exit 1

# ---------------------------------------------------------------- test 4
say "test 4: duplicate start yields one run  [$(stamp)]"
R="$(start_run "dup$SUFFIX")"
R2="$(start_run "dup$SUFFIX")"
if [ "$R" = "$R2" ] && [ "$(field "$R" "d['state']")" != "" ]; then
    ok "second POST /runs returned the same run ($R), not a second one"
else
    no "duplicate start produced different runs"
fi

# ---------------------------------------------------------------- test 5
say "test 5: reconnecting client sees the same state  [$(stamp)]"
A="$(curl -sS --max-time 3 -N "$BASE/runs/$R/events" 2>/dev/null | grep '^data:' | tail -1)"
B="$(curl -sS --max-time 3 -N "$BASE/runs/$R/events" 2>/dev/null | grep '^data:' | tail -1)"
if [ -n "$A" ] && [ -n "$B" ]; then
    ok "reconnect streamed state again without needing a replay log"
else
    no "SSE produced no frames on reconnect"
fi

# ---------------------------------------------------------------- test 2
say "test 2: kill during the approval wait  [$(stamp)]"
R="$(start_run "apr$SUFFIX")"
if wait_phase "$R" approve 40; then
    kill_host
    sleep 1
    start_host || exit 1
    if [ "$(field "$R" "s.get('phase')")" = "approve" ] \
        && [ "$(field "$R" "','.join(s.get('phases_completed') or [])")" = "investigate" ]; then
        ok "still waiting for approval after restart, investigate not repeated"
    else
        no "run did not survive the kill in the expected state"
    fi
    approve "$R"
    if wait_phase "$R" done 40; then
        ok "approval raised after restart completed the run"
    else
        no "run did not complete after approval"
    fi
else
    no "run never reached the approval wait"
fi

# ---------------------------------------------------------------- test 1
say "test 1: kill inside a tool call  [$(stamp)]"
rm -rf "$FIX_DIR"
R="$(start_run "tool$SUFFIX")"
sleep 2                       # inside apply_fix's 3s window
kill_host
sleep 1
start_host || exit 1
if wait_phase "$R" approve 60; then
    commits=0; [ -s "$FIX_DIR/fix.done" ] && commits=1
    if [ "$commits" = "1" ]; then
        ok "resumed past the killed tool call with exactly one commit"
    else
        no "expected one commit marker, found $commits"
    fi
else
    no "run did not resume after being killed inside a tool"
fi

# ---------------------------------------------------------------- test 3
say "test 3: kill inside the side effect, then resume  [$(stamp)]"
mkdir -p "$DEPLOY_DIR"
rm -f "$DEPLOY_DIR/${R#run-}.done"
approve "$R"
sleep 2                       # inside the 5s deploy activity
kill_host
sleep 1
start_host || exit 1
if wait_phase "$R" done 60; then
    if [ -s "$DEPLOY_DIR/${R#run-}.done" ]; then
        ok "deploy completed exactly once after the kill"
    else
        no "run reports done but the deploy marker is missing"
    fi
else
    no "run did not complete after being killed inside the activity"
fi

# ---------------------------------------------------------------- test 6
say "test 6: the log stream opens a run by itself  [$(stamp)]"
BEFORE="$(curl -sS "$BASE/runs" | python3 -c "
import json,sys
print('\n'.join(sorted(r['runId'] for r in json.load(sys.stdin))))
" 2>/dev/null)"
# Retire earlier incident runs so "a new run appeared" cannot be satisfied by an old one.
for old in $(printf '%s\n' "$BEFORE" | grep '^run-incident-'); do
    curl -sS -o /dev/null -X DELETE "$BASE/runs/$old"
done
kill_host
HOST_ENV="PILOT_TRIGGER=1 PILOT_TRIGGER_FAULT_AFTER=2"
# The run must be created after this moment, so a leftover from an earlier invocation cannot
# satisfy the test.
T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export T0   # must reach python3 on the right of the pipe, so export it
start_host || exit 1
RID=""
for _ in $(seq 1 60); do
    RID="$(curl -sS "$BASE/runs" | python3 -c "
import json,os,sys
# Compare to-the-second: both stamps are UTC ISO, and Python's fromisoformat rejects
# the 7-digit fractional seconds the service emits.
t0 = os.environ['T0'][:19]
for r in json.load(sys.stdin):
    stamp = (r.get('createdAt') or '')[:19]
    if stamp and r['runId'].startswith('run-incident-') and stamp >= t0:
        print(r['runId']); break
" 2>/dev/null)"
    [ -n "$RID" ] && break
    sleep 1
done
if [ -z "$RID" ]; then
    no "no run appeared on its own within 60s"
elif wait_phase "$RID" approve 60; then
    ok "opened $RID after $T0 with no client request, and it is waiting for approval"
else
    no "run $RID opened by the stream never reached the approval wait"
fi

say ""
say "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
