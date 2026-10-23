# Feature split: plan

Status: **approved, nothing implemented**. The store split landed first (`docs/agents/store-split.md`),
which is what makes this one small: there is a composition root to assemble features from, so the
remaining clutter is two hub files, not three.

Decisions settled on review: Q2 (every job under `features/jobs/`) and the slice 6 document-seeding
collapse are both in. Implement in slices, one commit each.

## Progress

| Slice | State | Evidence |
|---|---|---|
| 0 · Contract snapshot | done | `tests/contracts.test.ts` (3 tests): the 11 tool names in order, `JOB_DEFS` ids and each job's phase ids in order, `AGENT_DOC_KINDS`/`DEVICE_DOC_KINDS`; swapping two tools in `extensions.ts` fails it; no production change; `npm run check` clean, 52/52 tests pass |
| 1 · Prompt text out | todo | `src/prompt.ts` (or `descriptions.ts`); `extensions.ts` loses its 1,777-character line |
| 2 · Feature contract | todo | `features/feature.ts`, `features/jobs/types.ts`; types only, no moves |
| 3 · Jobs by job | todo | `features/jobs/{workspace-snapshot,release-check,change-watch,todo-digest,approval}.ts`, `defs.ts`; `jobs.ts` is a re-export shim |
| 4 · Phase runtime | todo | `features/jobs/runtime.ts`; `jobs.ts` deleted |
| 5 · Tools by feature | todo | `features/{app-state,todos,history,sessions,jobs,side-effects}/`; `playground.ts` assembles |
| 6 · Retire the hubs | todo | `extensions.ts` deleted; README and `docs/agents` point at the new paths |

## Goal

Turn `jobs.ts` (840 lines) and `extensions.ts` (581) into feature directories with one reason to
change each, without changing the HTTP, SSE, prompt or persisted contract.

A feature owns four things, and today they land in different hubs:

1. a document type and its `defineDoc`;
2. the tools that edit it;
3. the job or task that processes it;
4. wiring: registry install, conversation seeding, HTTP exposure, prompt text.

After this split, adding "todo priorities" touches `features/todos/` only, plus the seeding list in
`session-runtime.ts`.

## Non-goals

- Splitting the store again. It is done, and `device.ts` is accepted on its behavioural guardrail.
- Splitting `routes.ts` by prefix (audit step 6). Independent, and still open.
- One extension per feature with its own toggle. Q1 keeps one.
- Renaming documents, tables, tool names, job ids or HTTP paths. See [Contracts](#contracts-to-preserve).
- The frontend pass (audit step 7).

## Target layout

Only what this plan creates. Everything else in `src/` stays where it is.

```
apps/dpi-backend/src/
  jobs.ts                     deleted by slice 4; re-export shim until then
  extensions.ts               deleted by slice 6; re-export shim until then
  prompt.ts                   playground system prompt and long tool descriptions
  playground.ts               the assembler: features in, one Extension out
  features/
    feature.ts                Feature type, doc/task aliases, assembler helper
    app-state/
      doc.ts  tools.ts
    todos/
      doc.ts  tools.ts
    history/
      tool.ts
    sessions/
      tools.ts                subagent, start_session, handoff
    side-effects/
      pager.ts  tool.ts
    jobs/
      types.ts                JobModule, Handler
      runtime.ts              Phase, phaseApi, runPhase, run records, approval
      defs.ts                 JOB_DEFS in fixed order, assembled from modules
      tools.ts                list_durable_jobs, run_durable_job, check_durable_job
      workspace-snapshot.ts  release-check.ts  change-watch.ts  todo-digest.ts  approval.ts
```

`feature.ts` holds the one heterogeneous registration alias the coding standards allow (TS-101):

```ts
type AnyDoc = DocToken<JsonObject, DocDefinition<JsonObject>>;
type AnyTask = TaskDefinition<any, any, any, any>; // no precise common supertype exists

export type Feature = {
  docs?: AnyDoc[];
  tools?: ToolRegistration[];
  tasks?: AnyTask[];
  section?: Section;
};
```

## Decisions carried in

| # | Decision |
|---|---|
| Q1 | One `playground` extension, assembled from features. Per-feature toggles are a separate decision and would change the Extensions panel. |
| Q2 | Every job, including `todo-digest`, lives under `features/jobs/`. `features/todos/` owns the document and the tool. Reason: `defs.ts` imports job modules, and a job inside `features/todos/` would be a sibling-feature import (TS-702). **Answered: yes.** |
| Q3 | Jobs keep their own file even when short. One file per job is the point of slice 3. |
| Q4 | `jobs.ts` and `extensions.ts` become re-export shims for one slice each, so a failing slice is attributable. |
| Q5 | Tool and section order is the contract, not an implementation detail (PI-208). Slice 0 exists so a reorder fails a test, not a prompt cache. |
| Q6 | `Phase` and `Handler` are imported by job modules from `features/jobs/types.ts`, never from `runtime.ts`. |
| Q7 | Seed order in `session-runtime.ts` `conversationCreated` stays `Workspace`, `JobRuns`, `Todos`. A new document goes in both that seeder and `documents.ts`. |

## Slices

One slice per commit, each ending with `cd apps/dpi-backend && npm run check && npm test`. Do not
combine 3 and 5: both touch extension assembly and both can change tool order.

| # | Slice | Files | Gate |
|---|---|---|---|
| 0 | Contract snapshot | `tests/contracts.test.ts` | Test asserts the offered tool names in order, `JOB_DEFS` ids and their phase ids in order, and `AGENT_DOC_KINDS`/`DEVICE_DOC_KINDS`. No production change, all tests green. |
| 1 | Prompt text out | `src/prompt.ts`, `src/extensions.ts` | Pure text move: same string, same order. The contract test is unchanged. |
| 2 | Feature contract | `features/feature.ts`, `features/jobs/types.ts` | Types compile and nothing imports them yet. No behavior change. |
| 3 | Jobs by job | `features/jobs/*.ts`, `jobs.ts` shim | `JOB_DEFS` order and phase ids unchanged; `defineTask` names unchanged; `npm test` green with the old import paths. |
| 4 | Phase runtime | `features/jobs/runtime.ts`, delete `jobs.ts` | No module outside `features/jobs/` imports the phase API; every caller imports `defs.ts` or `runtime.ts` directly. |
| 5 | Tools by feature | `features/*/`, `playground.ts`, `extensions.ts` shim | Tool order in `createPlayground` unchanged (contract test); `createPlayground(shared, sessionId, spawn, jobs)` keeps its signature until slice 6. |
| 6 | Retire the hubs | delete `extensions.ts`, move `Workspace`, `SpawnSession`, `AGENT_DOCS` to their owners | No `src/*.ts` file over ~300 lines except `device.ts` and `model-catalog.ts`; `npm test` and `just hub test` green. |

### Slice 5 detail

`createPlayground` keeps its four arguments so `session-runtime.ts` does not change in the same
slice. It becomes:

```ts
export function createPlayground(shared: SharedState, sessionId: string, spawn: SpawnSession, jobs: Jobs) {
  const features = [
    appState(shared),
    todos(),
    jobsTools(jobs),
    historyTools(),
    sessionTools(sessionId, spawn),
    pager(),
  ];
  return defineExtension({
    name: "playground",
    tasks: jobs.tasks,
    tools: features.flatMap((f) => f.tools ?? []),
    sections: [playgroundSection()],
  });
}
```

`Workspace` (the App State document, `extensions.ts:25`) and `SpawnSession` (the type,
`extensions.ts:164`) move out in the same slice, to `features/app-state/doc.ts` and
`features/sessions/types.ts`: `documents.ts`, `device.ts`, `session-runtime.ts` and
`tests/recovery.test.ts` all import them from `extensions.ts` today. `AGENT_DOCS` already lives in
`documents.ts`, and the client keeps its own copy in `composables.ts` — that duplication is the
risk below, not part of this slice.

## Contracts to preserve

Persisted or client-visible, so the split must not rename them (standards DP-104, PI-208):

- document kinds: `demo.workspace`, `demo.job-runs`, `demo.todos`, `demo.todo-receipt`,
  `demo.pager`, `demo.receipt`, `app.shared-state`, `ext.system-prompts`
- tool names and their order, including `todo`, `run_durable_job`, `check_durable_job`
- job ids and phase ids, because run records and `demo.job-runs` store both
- task definition names such as `demo.job.todo-digest` and `demo.job-approval`
- SQLite table and column names
- HTTP paths, query parameters and SSE frame kinds
- the section text and section order, which are prompt

## Risks and guardrails

- **Tool order is prompt order.** `extensions.ts` declares 11 tools in a deliberate sequence;
  `flatMap` over features reproduces it only if the feature array keeps that sequence. Slice 0 is
  the guard, and slice 5 must not touch slice 3's output in the same commit.
- **`createPlayground` is called from one place** (`session-runtime.ts` `open`) but imported by
  `device.ts` and `tests/recovery.test.ts` for `SpawnSession` and `Workspace`. Slice 5 moves those
  symbols; slice 6 deletes the shim.
- **Seeding and the kind registry drift apart.** A new document must be added in three places today:
  `session-runtime.ts` (`conversationCreated`), `documents.ts` (`AGENT_DOCS`) and the client's
  `composables.ts` list. Slice 6 should make the first two one list, or the plan has not removed the
  cost the audit named.
- **Job handlers reach the runtime through the `Phase` object**, not through `Jobs`. Keep that seam:
  job modules must not import `createJobs`.
- **`demo.job-runs` is pruned to 30 runs** (`MAX_RUNS`). Any change to run-record shape must keep the
  pruning order, or old runs survive a version bump.

## Acceptance criteria

- each job's definition, handlers and result shape live in one file
- each tool family lives with the document it edits and has one registration point
- `features/` imports `feature.ts`, `features/jobs/types.ts`, the modules it needs and SDK types;
  never a sibling feature
- no backend source file outside tests, `device.ts`, `model-catalog.ts` and generated data exceeds
  roughly 300 lines
- the slice 0 contract test is unchanged

## Open decisions

None. Q2 settled as written above, and slice 6 includes the single document-seeding list: one list in
`documents.ts` that `session-runtime.ts` iterates, so a new document cannot be registered in one place
and seeded in another.

## Confirmation needed

Nothing blocking. Slice order is 0 → 6, one commit each, shims kept in 3 and 5. The first run lands
slices 0 and 1 and stops for review before any file moves.
