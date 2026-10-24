# Pilot findings

Notes from building the walking skeleton, in order. These are the things that cost time and
would cost it again.

## Verified on this stack

`net10.0`, `Microsoft.Agents.AI.DurableTask` 1.16.0-preview, `Microsoft.DurableTask.Worker/Client
.AzureManaged` 1.27.0, DTS emulator container. These compose without version surgery: the preview
agent package depends on `Microsoft.DurableTask.Client/Worker` >= 1.18.0, which resolves up to the
GA 1.27.0 you use for the scheduler.

Three failure tests pass against the emulator (`t1`–`t3` in the run log):

1. **Kill during the approval wait.** Process killed; after restart the run is still `approve`,
   still waiting, `phases_completed` intact, nothing re-executed.
2. **Kill inside the side effect.** Killed 1.5 s into a 5 s activity. On restart the activity ran
   again, saw its run-scoped marker, and the effect landed once. This is the .NET shape of
   Durable Pi's "replay-safe vs interrupted" distinction: at-least-once execution plus a marker
   you own, not a per-tool flag the engine gives you.
3. **Duplicate start and duplicate approval.** The instance id is derived from the client's run
   key, so a second `POST /runs` returns `created: false`. A second approval on a completed run is
   accepted, recorded in history, and never consumed.

## Gotchas

- **Custom status needs `getInputsAndOutputs: true`.** `GetInstanceAsync(id, false)` returns
  `SerializedCustomStatus == null` even when the orchestrator has set one. The SSE endpoint silently
  streamed one frame with `status: null` until this was fixed. Everything client-visible is gated
  behind this flag.
- **`AddActivityFunc<TInput, TOutput>`** is needed for a value-returning activity; the single-generic
  overload binds to `Task`/void and fails with `CS0407`, which does not hint at the fix.
- **`RunRequest` collides** with `Microsoft.Agents.AI.DurableTask.RunRequest`. Namespace collisions
  are routine in this stack; name your DTOs away from the agent types.
- **`DurableAIAgent` comes from the orchestration context**, not DI:
  `context.GetAgent("Name")`, then `CreateSessionAsync()`, then `RunAsync(message, session)`.
  The DI-registered `AIAgent` is the proxy for scheduling from outside an orchestration.
- **The orchestrator is code that re-executes.** Mutable locals survive replay because completed
  awaits return recorded results; anything read from the outside world inside the orchestrator is a
  determinism bug.

## Not yet exercised

- Harness capabilities (todo, compaction, tool approval) on top of `DurableAIAgent`.
- Real model via `IChatClient`; today's client is scripted, so no tool-calling loop yet.
- The proactive trigger (log stream starting a run by itself).
- Replay across a package upgrade — expected to be the test that breaks.
