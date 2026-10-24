# Handoff: durable agents on .NET/Azure — pilot

Written 2026-10-24. Continues the session that built `pilot/` in `/c/Projects/durable-pi`
(branch `deploy/sbx`).

## What this is about

The user's own project (durable-pi, a TypeScript durable agent harness with SQLite, a device
server and a proactive incident demo) is the thing they know. At their job the stack is **Azure +
.NET**, and they asked whether an equivalent exists. It does, closely, and they green-lit a pilot
to prove it: parity with `apps/proactive-dpi-demo`, hosted on Azure with Durable Task Scheduler
allowed, built inside this repo.

The pilot is **feature-complete against that goal** and has 7 passing failure tests. Three commits
so far: `edf16a1` (design + walking skeleton), `7884ed5` (tools + the version-skew finding),
`aa01c43` (proactive trigger + test suite).

## Read these, don't re-derive them

| Artifact | Why |
|---|---|
| `pilot/README.md` | The design: shape, state-ownership table, three-endpoint contract, the six failure tests, runbook and env switches |
| `pilot/docs/adr/0001-durable-agents-on-dotnet.md` | Engine/hosting decision, five rejected alternatives, consequences |
| `pilot/FINDINGS.md` | **Start here.** The version-skew failure mode, every gotcha that cost time, testing traps |
| `pilot/run-failure-tests.sh` | The acceptance criteria as executable tests (~25s) |
| `pilot/src/Pilot.AgentHost/` | Program.cs (orchestration + endpoints), LogStreamService.cs, IncidentTools.cs, ScriptedChatClient.cs, Models.cs |

## State of the world

- **Repo**: 3 commits on `deploy/sbx`, working tree clean. Nothing pushed.
- **.NET**: SDK 10.0.402 at `~/.dotnet`, persisted in `/etc/sandbox-persistent.sh`. Use
  `bash -l -c 'dotnet …'` if a bare `dotnet` is not found.
- **Emulator**: container `dtsemulator` running, gRPC `:8080`, dashboard `:8082`.
- **Host**: currently running on `:5099` with the trigger enabled (pid from `pgrep -f
  'net10.0/Pilot.AgentHost'`). Kill it before starting another or the new one will fail to bind.
- **Build config**: default build pins `Microsoft.Agents.AI` 1.13.0 / `Microsoft.Extensions.AI`
  10.6.0 and compiles the harness out. `-p:PilotHarness=true` switches it on and reproduces the
  stall described in FINDINGS.md.

### Two operational traps that cost real time

1. **Never `pkill -f 'Pilot.AgentHost'`.** The pattern matches your own shell command line and kills
   the session. Kill by pid: `p=$(pgrep -f 'net10.0/Pilot.AgentHost' | head -1); [ -n "$p" ] && kill -9 "$p"`.
2. **`git commit` intermittently fails** with `cannot update ref … nonexistent object` on this
   mounted filesystem. The commit object is written; retry, or `sync` first. Repeated `git commit`
   succeeded every time.

## Web/search tooling is broken here

`web_search` fails with both configured providers: `ollama` returns 401 (`ollama signin` needed) and
`searxng` returns `fetch failed`. `web_fetch` works fine. What worked instead:

- Microsoft docs: fetch `https://learn.microsoft.com/en-us/<path>` and filter the nav boilerplate
  (the useful text sits below ~200 lines of chrome). `https://learn.microsoft.com/en-us/agent-framework/toc.json`
  lists every page.
- Package facts: `https://api.nuget.org/v3-flatcontainer/<id>/index.json` for versions,
  `…/<id>/<version>/<id>.nuspec` for dependency ranges, and unzip the `.nupkg` and grep
  `lib/net10.0/*.xml` for the real public API surface. This is how the API was pinned down without
  docs.
- Samples: `gh api repos/microsoft/agent-framework-durable-extension/git/trees/main?recursive=1`
  then `raw.githubusercontent.com`. The samples live in **that** repo, not `agent-framework`.

## What's left, in priority order

1. **A real model.** Everything runs on `ScriptedChatClient`, which issues real `FunctionCallContent`
   so the tool loop is genuinely exercised, but no live model has ever been used. Wire Azure OpenAI
   or Foundry behind `IChatClient` (`PILOT_AGENT=plain` path), keep the scripted client as the test
   double, and confirm the tool loop and approval still hold. This is the largest untested surface.
2. **Replay across a package upgrade.** Now known to be the dangerous one rather than "expected to
   break": see the version-skew section of FINDINGS.md. Start a run on the pinned pair, upgrade, and
   see whether in-flight runs resume or stall. Write the result down either way.
3. **Optional thin-loop work** if the user wants harness-level behaviour without the harness:
   compaction, plan/todo state, per-tool approval policy. `FunctionInvokingChatClient`
   (`MaximumIterationsPerRequest`) and `UseOpenTelemetry()` are available from
   `Microsoft.Extensions.AI` 10.6 without the harness.
4. **Do not** bump `Microsoft.Agents.AI` past 1.13 without doing step 2 first.

## Nothing sensitive in play

No credentials anywhere: the scripted client needs none, the emulator runs locally, and no Azure
resources were created. If the next session adds Azure OpenAI, keep keys in an env file that is
git-ignored, and never echo them.

## Suggested skills

Call these with the Skill tool:

- **`diagnosing-bugs`** — for step 2. A stalled orchestration is exactly the "silent, no error
  logged, work appears done" class this skill is for; the method that cracked it last time was
  reading `GET /runs/{id}/history` and comparing `actionCount`, then bisecting with controls
  (plain agent vs harness, one capability at a time).
- **`tdd`** — before adding the real-model path or compaction. The pilot's value is its seven tests;
  new behaviour should land with a failing test first, in `run-failure-tests.sh` or alongside it.
- **`code-review`** — if the user is about to show this to their team. Review since `edf16a1`
  (or the merge-base) against `pilot/README.md` as the spec and the repo's `CODING_STANDARDS.md`
  (note: those standards are TypeScript-specific; flag C# deviations as judgment, not rule
  violations).
- **`unslop`** — applies to any prose written into `pilot/*.md` or a PR body.
- **`wizard`** — only if the pilot graduates to real Azure: provisioning a Durable Task Scheduler,
  setting `DURABLE_TASK_SCHEDULER_CONNECTION_STRING`, and managed-identity/credential setup are
  human-in-the-loop, host-side steps.
- **`pr`** — when the user wants to open a PR rather than keep this local. Nothing is pushed yet.
