# Pilot findings

Notes from building the pilot, in order. These are the things that cost time and would cost it
again.

## The finding that matters: version skew silently breaks the durable agent

`Microsoft.Agents.AI.DurableTask` 1.16.0-preview was compiled against `Microsoft.Agents.AI` **1.13.0**
and `Microsoft.Extensions.AI` **10.6.0**. Adding `Microsoft.Agents.AI.Harness` 1.26.0 pulls
`Microsoft.Agents.AI` **1.26.0** and `Microsoft.Extensions.AI` **10.10.x** upward, and NuGet resolves
that without a complaint. The build is clean, the app starts, the agent produces a correct answer —
and **every run stalls at the first agent turn, forever.**

The shape of the failure is worth recognising, because nothing logs an error:

- Orchestration history ends with `ExecutionStarted`, `EventSent`, then one `EventRaised` whose name
  is a v5 (name-based) UUID, and then nothing.
- The orchestrator work item completes with `actionCount=0` — no timers, no messages. It is waiting
  for an event name it will never compute the same way again.
- The agent entity logs a perfectly good `Response: [assistant] ...` before the stall. The work
  happened; the answer was then lost.

So the durable agent's request/response correlation is a name-based UUID computed from the run
request, and the version bump changes what that computation sees. The mismatch is silent: an event
that matches no waiter is consumed, and the orchestration idles.

**This is not a harness bug.** The control test settles it: a plain `ChatClientAgent` — no harness,
no context providers — with `Agents.AI` 1.26 in the graph stalls identically. Bisecting the harness
one capability at a time (file memory, todo, agent mode, auto-approval, OpenTelemetry, compaction,
web search, skills) reproduces the stall with **all of them disabled**.

Current state in this repo: the working configuration pins `Microsoft.Agents.AI` 1.13.0 and
`Microsoft.Extensions.AI` 10.6.0, and the harness is behind `-p:PilotHarness=true` so the stall stays
reproducible without breaking the pilot:

```bash
dotnet build src/Pilot.AgentHost                                  # working: pinned pair
dotnet build src/Pilot.AgentHost -p:PilotHarness=true             # reproduces the stall
```

Practical consequence for a real pilot: **you cannot put the GA harness on a durable agent today.**
Buy `DurableAIAgent` for durability, or `HarnessAgent` for the batteries-included loop, not both
until the durable extension moves to `Agents.AI` 1.26+. This is the single most valuable thing the
pilot found, and it is invisible in the docs.

## Verified working (pinned pair, tools, `net10.0`, DTS emulator)

Failure tests, all against a killed process:

1. **Kill during the approval wait.** After restart: still `approve`, still waiting,
   `phases_completed` intact, nothing re-executed.
2. **Kill inside a tool call.** Killed 2 s into a 3 s `apply_fix` tool. On restart the entity
   re-ran, the tool saw its run-scoped marker, and exactly one commit was recorded. This is the .NET
   shape of Durable Pi's "replay-safe vs interrupted": at-least-once execution plus a marker you
   own, not a per-tool flag the engine gives you.
3. **Kill inside a side effect after approval.** Killed 1.5 s into a 5 s deploy activity; resumed and
   deployed once.
4. **Duplicate start, duplicate approval.** Instance id derives from the client's run key, so a
   second `POST /runs` returns `created: false`. A second approval on a completed run is accepted,
   recorded in history, and never consumed.
5. **Reconnecting client.** SSE re-reads state; no event log to replay, no duplicated frames.

Tool calling works inside a durable turn: the agent calls `read_logs`, feeds the log line back into
the model, calls `apply_fix`, and the final answer carries the commit id. Tool results persist in the
durable session across the restart.

## Gotchas

- **Custom status needs `getInputsAndOutputs: true`.** `GetInstanceAsync(id, false)` returns
  `SerializedCustomStatus == null` even when the orchestrator set one. The SSE endpoint silently
  streamed `status: null` until this was fixed. Everything client-visible is behind this flag.
- **`AddActivityFunc<TInput, TOutput>`** is needed for a value-returning activity; the single-generic
  overload binds to `Task`/void and fails with `CS0407`, which does not hint at the fix.
- **`RunRequest` collides** with `Microsoft.Agents.AI.DurableTask.RunRequest`.
- **Harness options are evaluation-only.** Several `HarnessAgentOptions` members raise `MAAI001`
  (error by default); the pilot opts out in the csproj.
- **`DurableAIAgent` comes from the orchestration context** (`context.GetAgent("Name")`), not DI. The
  DI-registered `AIAgent` is the proxy used to schedule from outside an orchestration.
- **`GetOrchestrationHistoryAsync` is the debug tool.** `/runs/{id}/history` exists in this pilot for
  exactly that; a stalled run is undiagnosable from logs alone.

## Testing notes

`./run-failure-tests.sh` runs all six acceptance tests in about 25 seconds. Start the host by running
the compiled apphost, not `dotnet run`: MSBuild evaluation adds ~35 s per start, and the script
restarts the host five times, which is the difference between 25 seconds and 15 minutes.

Two traps when asserting on this system:

- An SSE frame ends with a blank line, so `tail -1` on the stream returns `""`. Take the last line
  matching `^data:`.
- The deploy activity keys its marker by the **client run key** while orchestration ids are
  `run-<key>`. Comparing `/tmp/pilot-deploy/run-<key>.done` always finds nothing.

## Not yet exercised

- The proactive trigger (log stream starting a run by itself). Next slice.
- Replay across a package upgrade — now known to be the dangerous one, not merely expected.
- A real model: the client is scripted so tests need no credentials. Nothing here has been proven
  against a live model's tool-calling loop.
- Durable Pi's App State has no counterpart in this pilot; the nearest .NET shape is a durable entity.
