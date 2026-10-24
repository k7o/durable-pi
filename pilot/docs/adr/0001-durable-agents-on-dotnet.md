# Durable agents on .NET run on Durable Task, self-hosted

Status: proposed

A .NET/Azure shop needs to reproduce Durable Pi's core claim — an agent run survives
its own process, and clients only watch and steer — without porting the harness or the
engine. We build the pilot on `Microsoft.Agents.AI` (harness, tools, sessions) plus
`Microsoft.Agents.AI.DurableTask` (durable execution) running in a **self-hosted worker**
process that connects to **Durable Task Scheduler** in Azure and the **DTS emulator**
container locally. Durable Task is chosen because it is the only option that gives us
both the agent-facing bits (session persistence, human-in-the-loop waits, workflow
checkpoints) and the run-ownership bits (deterministic replay, external events, instance
management) from one vendor stack, and because it is the same thing the shop already
gets with Durable Functions if the pilot graduates.

## Considered Options

- **Durable Functions** — same engine, but the programming model is Functions triggers and
  the host owns our HTTP surface. Harder to mirror a `dpi-backend`-shaped device server
  with its own endpoints and auth. Rejected for the pilot; not rejected for production.
- **Temporal .NET** — the strongest "runs anywhere" story and a SQLite dev server, but no
  agent/harness layer, so we would write the interoperability ourselves. Kept as the
  fallback if DTS is disallowed.
- **Elsa Workflows 3** — good fit for named-phase durable jobs with human tasks and
  SQLite/Postgres persistence, weak fit for a coding-agent loop. A candidate for the
  workflow half only.
- **Foundry hosted agents** — closest managed shape, but the platform owns the endpoint,
  identity and session state. That inverts the device-owns-the-run property under test.
- **Hand-rolled on EF Core + SQLite** — what Durable Pi already is. The pilot's purpose is
  to avoid writing this again.

## Consequences

- **No SQLite task hub.** Local runs need the DTS emulator container; on-prem production
  means Durable Task Scheduler (Azure) or the MSSQL provider. The single-file,
  one-machine-owns-its-state deployment model does not carry over, and a pilot result does
  not transfer to an air-gapped or box-only deployment.
- **Pinned to `net10.0`.** `Microsoft.Agents.AI.DurableTask` targets net10.0 only, so the
  pilot cannot run on a .NET 8 shop baseline as-is.
- **The durable-agent path is prerelease** while the harness and DTS clients are GA. Expect
  churn; pin versions and budget one upgrade pass.
- **Orchestrator determinism is now our problem.** No `DateTime.Now`, no I/O, no
  non-deterministic loops in orchestrator code. Activity boundaries are where effects and
  clock reads live.
- **Replay safety becomes a per-tool contract we write**, not a tool property we declare.
  Durable Pi's `replay-safe` flag has no built-in counterpart.
