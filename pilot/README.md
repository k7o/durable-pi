# Durable agents on .NET — pilot

A self-contained spike that reproduces the Durable Pi model on the Microsoft stack:
a durable agent run, an approval that waits across a restart, a client that only watches
and steers, and a proactive trigger off a log stream. Parity target is
[`apps/proactive-dpi-demo`](../apps/proactive-dpi-demo).

This is a separate context from the TypeScript monorepo: it has its own glossary
decisions in [docs/adr](docs/adr) and does not participate in `just`, `apps/` or the
`dpi-*` packages. Vocabulary is reused from the repo-root [GLOSSARY.md](../GLOSSARY.md)
wherever it still applies: **run**, **phase**, **step**, **approval**, **conversation**,
**entry**, **submission** keep their meaning. Two terms do not carry over and are used
with their .NET meaning only: **orchestration** (a Durable Task instance) and
**activity** (a unit of replayed-safe work).

Status: **pilot, time-boxed.** Build to answer one question — does the durable-agent
model hold on this stack — not to ship.

## Shape

```
pilot/
  src/Pilot.AgentHost/     self-hosted durable worker + HTTP endpoints (the "device")
  src/Pilot.Client/        thin client: start a run, stream it, raise an approval
  src/Pilot.Triggers/      log stream -> starts a run on its own (proactive)
  tests/Pilot.FailureTests/ the kill-and-resume tests that define acceptance
```

Only `Pilot.AgentHost` exists so far. The trigger lives inside it as a hosted service
(`LogStreamService`) rather than a separate project: it needs the same Durable Task client the host
already has, and a second process would only add a way for the two to disagree.

Packages: `Microsoft.Agents.AI`, `Microsoft.Agents.AI.DurableTask`,
`Microsoft.DurableTask.Worker.AzureManaged`, `Microsoft.DurableTask.Client.AzureManaged`, and
optionally `Microsoft.Agents.AI.Harness`. Target `net10.0` (constraint, see ADR 0001). Package
versions are pinned deliberately: the durable extension needs `Microsoft.Agents.AI` 1.13.0, and the
harness pulls 1.26.0, which breaks runs silently. See [FINDINGS.md](FINDINGS.md).

## Design decisions that must be settled before code

### 1. State ownership

Every piece of state has exactly one owner. Getting this wrong is the only failure mode
that costs a rewrite, because orchestrator history cannot be repaired after the fact.

| State | Owner | Durability | Notes |
|---|---|---|---|
| Conversation transcript | Agent Framework session, persisted by the Durable Extension | Orchestration history | Rebuilt on replay; never written from an activity |
| Run status (`queued`, `investigating`, `awaiting-approval`, `done`) | Orchestrator local variable | Orchestration history | Derived, not stored twice |
| Checklist of phases completed | Orchestrator local variable | Orchestration history | Append-only inside one run |
| Approval payload (who approved, when, why) | External event body | Orchestration history | Arrives via `WaitForExternalEvent` |
| Tool side effects (commit created, deploy rolled out) | The external system | Not ours | Must be idempotent by a run-scoped key |
| Tool output that is expensive to recompute | Activity return value | Orchestration history | If large, an activity writes a blob and returns a handle |
| Client-visible event log | SignalR/SSE fan-out from orchestration progress | Best-effort | A reconnecting client re-reads orchestration state, not the log |
| Durable Pi's App State | **No equivalent** | — | Nearest is a durable entity; not in the pilot |

Rule: an orchestrator may only read state it can derive from history or from an activity
result. Anything else is an activity.

### 2. Endpoints

Three, and the pilot does not get more:

| Endpoint | Purpose |
|---|---|
| `POST /runs` | Admit a run. Body carries a client idempotency key; a repeat returns the existing run, does not start a second. |
| `GET /runs/{id}` | Read run state: status, phases completed, approval requested, result. Idempotent, safe to poll. |
| `POST /runs/{id}/approvals` | Raise the external event that an approval phase is waiting on. Idempotent per `(run, phase)`. |

Streaming is a `GET /runs/{id}/events` SSE endpoint layered on the same state, not a
fourth source of truth.

The pilot also exposes `GET /runs` (the list a hub client reads), `GET /stream` (watched log plus the
code-side rule's state), `GET /runs/{id}/history` (raw orchestration history, for stalls) and
`DELETE /runs/{id}`. None of them is a new source of truth: they read the same committed state.

### 3. Failure tests define acceptance

The pilot is done when these pass against a killed process, with the emulator running:

1. **Kill mid-tool.** Kill the host during a long activity. On restart the run continues
   past the completed activity; the activity does not execute twice.
2. **Kill during approval.** Kill while a run is waiting for approval. Restart; the run is
   still waiting. Raise the approval; the run proceeds. Nothing runs twice.
3. **Kill after the event, before the ack.** Raise an approval and kill the host in the
   same window. The run must not lose the approval and must not apply it twice.
4. **Duplicate start.** `POST /runs` twice with one idempotency key yields one run.
5. **Reconnecting client.** Disconnect the SSE client mid-run, reconnect, and end up with
   the same run state and no duplicated events.
6. **Replay after upgrade.** Bump the preview package version and confirm existing
   in-flight runs still replay. Expected to be the test that breaks; record it.

## Runbook

```bash
# emulator
docker run -d --name dtsemulator -p 8080:8080 -p 8082:8082 mcr.microsoft.com/dts/dts-emulator:latest

# the acceptance criteria: builds, starts the emulator and host, runs all six tests (~25s)
./run-failure-tests.sh

# or host by hand (working configuration: pinned Agents.AI 1.13, no harness)
dotnet build src/Pilot.AgentHost
./src/Pilot.AgentHost/bin/Debug/net10.0/Pilot.AgentHost --urls http://127.0.0.1:5099

# admit a run, read it, approve the deploy, watch it
curl -X POST localhost:5099/runs -H 'content-type: application/json' \
  -d '{"run_key":"demo1","incident":"guest checkout 500s"}'
curl localhost:5099/runs/run-demo1
curl localhost:5099/runs/run-demo1/history        # raw orchestration history, for stalls
curl -N localhost:5099/runs/run-demo1/events      # SSE
curl -X POST localhost:5099/runs/run-demo1/approvals \
  -H 'content-type: application/json' -d '{"approved":true,"feedback":"ship it"}'
```

Switches, all environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PILOT_AGENT` | `plain` | `harness` requires `-p:PilotHarness=true` and currently stalls |
| `PILOT_TOOLS` | `1` | `0` removes the tool loop |
| `PILOT_DISABLE` | empty | harness capabilities to switch off, for bisecting a stall |
| `PILOT_TRIGGER` | `0` | `1` watches the log stream and opens runs by itself |
| `PILOT_TRIGGER_FAULT_AFTER` | `8` | stream lines before the bad deploy starts failing |
| `DURABLE_TASK_SCHEDULER_CONNECTION_STRING` | emulator | point at a real scheduler |

Model access is behind `IChatClient`. The default is a deterministic scripted client that issues
real tool calls, so the failure tests need no credentials; swapping in Azure OpenAI is a one-line
change where the client is constructed.

**Do not add `Microsoft.Agents.AI.Harness` to the default build.** It drags `Microsoft.Agents.AI`
from 1.13 to 1.26 and every run then stalls at the first agent turn with no error. See
[FINDINGS.md](FINDINGS.md).
