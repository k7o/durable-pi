# Feature split: plan

Status: **implemented, slices 0–6** (see [Progress](#progress)). The store split landed first
(`docs/agents/store-split.md`),
which is what makes this one small: there is a composition root to assemble features from, so the
remaining clutter is two hub files, not three.

Decisions settled on review: Q2 (every job under `features/jobs/`) and the slice 6 document-seeding
collapse are both in. Implement in slices, one commit each.

## Progress

| Slice | State | Evidence |
|---|---|---|
| 0 · Contract snapshot | done | `tests/contracts.test.ts` (4 tests): the 11 tool names in order, `JOB_DEFS` ids and each job's phase ids in order, `AGENT_DOC_KINDS`/`DEVICE_DOC_KINDS`, and the prompt table's keys in offered order (third commit); swapping two tools in `extensions.ts` fails it; no production change; `npm run check` clean, 53/53 tests pass |
| 1 · Prompt text out | done | `src/prompt.ts`: `PLAYGROUND_SECTION` (1,764 chars of text; the audit's 1,777 counted the indented source line) and `TOOL_DESCRIPTIONS` for all 11 tools in offered order; `extensions.ts` 581 → 571 lines; every description and the section are byte-identical to the literals they replaced; the contract test needed no change; `npm run check` clean, 53/53 tests pass |
| 2 · Feature contract | done | `features/feature.ts` (`Feature`, with the TS-101 `AnyDoc` alias and pi-durable's own `AnyTask`), `features/jobs/types.ts` (`Phase`, `Handler`, `Outcome`, `JobModule`); types only, imported by nothing; `npm run check` clean, 53/53 tests pass |
| 3 · Jobs by job | done | `features/jobs/{workspace-snapshot,release-check,change-watch,todo-digest}.ts` (one `JobModule` each: definition plus handler per phase), `defs.ts` (`JOB_DEFS` in the same order, `jobDef`, `resolveJobInput`, `HANDLERS`), and `shared.ts` (the `RESULT_ROOT` path, `clip`, `inDir`, `label` that more than one job shares — an addition to this plan's file list); every definition and handler is whitespace-for-whitespace the same text; `jobs.ts` keeps the engine and phase runtime and re-exports `JOB_DEFS`/`jobDef`/`resolveJobInput`, so old import paths still work; `npm run check` clean, 53/53 tests pass |
| 4 · Phase runtime | done | `features/jobs/runtime.ts` (dispatch: `runPhase`, `finish`, `fail`, `approvalPhase`), plus `phase.ts` (the `Phase` object a handler gets), `record.ts` (`JobRuns`, run types, `runOf`/`upsertStep`/`endRun`), `approval.ts` (the approval task) and `engine.ts` (`createJobs`, `start`, `Jobs`) — the plan named one runtime file, which would have been ~390 lines; `jobs.ts` deleted; no module outside `features/jobs/` imports the phase API; `npm run check` clean, 53/53 tests pass |
| 5 · Tools by feature | done | `features/app-state/{doc,tools}.ts`, `features/todos/{doc,tools}.ts` (`src/todos.ts` moved here), `features/history/tool.ts`, `features/sessions/{types,tools}.ts`, `features/side-effects/{pager,tool}.ts`, `features/jobs/tools.ts`, and `features/receipt.ts` for the `demo.receipt` document the App State write and `run_durable_job` share (an addition to this plan's list); `src/playground.ts` assembles and keeps `createPlayground`'s four arguments; the store-split `Playground` class moved to `src/demo.ts` (same class, same behaviour) to free the name this plan wanted; tool order unchanged (the plan's sketch put the session tools before the pager, which would have reordered the prompt — the contract test pins the shipped order); `extensions.ts` is a 6-line shim; `npm run check` clean, 53/53 tests pass |
| 6 · Retire the hubs | done | `extensions.ts` deleted, its five importers name their new paths; `Workspace`, `SpawnSession` and the conversation documents live with their owners; `documents.ts` holds one `CONVERSATION_DOCS` list that the registry, the reads and `seedConversation` all use, so `session-runtime.ts` no longer names a document; no backend source file over 300 lines except `device.ts` (384) and `model-catalog.ts` (300); `npm run check` clean, 53/53 tests pass; hub `build`, `lint` and `tests` pass (`just hub check` by hand, since `just` is not installed in this sandbox) |

Note: every slice is one commit on `refactor/feature-split`, in order 0 → 6, each gated on
`cd apps/dpi-backend && npm run check && npm test`. See [Code review fixes](#code-review-fixes) for the
review of slices 0–1 and [Landed layout](#landed-layout) for the files that differ from the target tree.

## Landed layout

The target tree above was a sketch, and the implementation needed more files than it named. Everything
it listed exists; these are the additions, each with one reason to change:

```
src/
  demo.ts                     the store-split `Playground` class, moved to free the playground.ts name
  playground.ts               the assembler (this plan's file)
  extensions.ts               DELETED by slice 6
  documents.ts                one CONVERSATION_DOCS list: kind registry, reads and seeding
  features/
    receipt.ts                demo.receipt, shared by update_state and run_durable_job
    app-state/doc.ts          Workspace moved out of extensions.ts
    sessions/types.ts         SpawnSession moved out of extensions.ts
    todos/doc.ts              src/todos.ts, plus the todo receipt document
    jobs/shared.ts            RESULT_ROOT and the helpers two jobs share
    jobs/record.ts            demo.job-runs, the run types, runOf/upsertStep/endRun
    jobs/phase.ts             the Phase object a handler receives
    jobs/approval.ts          the approval task
    jobs/engine.ts            createJobs, start, Jobs
```

Tool order is unchanged. The plan's slice 5 sketch listed the session tools before the pager; the
shipped order is `ping_on_call_engineer`, then `subagent`, `start_session`, `handoff`, which is what
the contract test pins.
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

## Code review fixes

Two reviews ran on `b309916..HEAD` after slices 0 and 1 (Standards against `CODING_STANDARDS.md` and
`ai_docs/durable_pi/maintainability-audit.md`, Spec against this plan). Addressed in the third commit:

- the prompt table was unguarded: `contracts.test.ts` now asserts `Object.keys(TOOL_DESCRIPTIONS)`
  against the offered tool names, so a stale key or a reordered entry fails the suite. Both axes
  found this; it is what makes the "in the order `createPlayground` offers the tools" comment true
  (Q5, PI-208).
- `TOOL_DESCRIPTIONS` is `as const`, like the other literal tables (TS-105), and `prompt.ts` says
  what it owns: tool-level descriptions, with argument descriptions left beside their schemas
  (TS-704).
- the contract fixture assembles the extension once behind a throwing-stub helper, and the stub
  covers `shared` too, so its comment no longer claims more than it proves.
- the document-kind assertion compares sorted sets. Key order is not a contract and Q7 seeds
  conversations `Workspace`, `JobRuns`, `Todos`, so pinning the registry's key order would only
  fight the one seeding list slice 6 creates.

Deferred, with reasons:

- `demo.receipt`, `demo.pager`, `demo.todo-receipt` and `ext.system-prompts` are still unguarded by
  name. They are contracts (DP-104) but not in slice 0's gate; slice 6 moves the kinds that are.
- the audit's step 0 also asks for the `demo.todos`/`demo.job-runs` document responses. Both already
  have response tests in `tests/api.test.ts`, so a rename fails there.

## Code review fixes, slices 2–6

Two reviews ran on `b98875c..HEAD` (Standards against `CODING_STANDARDS.md` and the audit, Spec against
this plan). Both axes found the same first issue. Addressed:

- `Feature.docs` and `.section` were declared and never read: `docs` was filled by three features into a
  field nothing consumed, and its comment promised a registry and seeder that read `documents.ts`'s own
  list (TS-705). The type is now `{ tools, tasks }`; `tasks` is real (the assembler takes them from
  `jobsTools`), and documents stay owned by each feature's `doc.ts` and listed once in `documents.ts`.
- the workspace kind was a string literal in two places while its siblings used owned constants
  (TS-104): `WORKSPACE_DOC` now sits beside `Workspace`.
- `runtime.ts` still claimed to own one task per job, which `engine.ts` does now, and `defs.ts` claimed
  to hold only the catalogue while also validating input (TS-704).

Accepted, fixed afterwards:

- **`features/jobs/` imported `features/todos/doc.js`** (`types.ts` for the `TodosDoc`/`TodoDigest` types,
  `phase.ts` for the `Todos` token), which the acceptance criteria above rule out (TS-702). The cause was
  `Phase.todos()`/`saveTodoDigest()`: the digest job has to read the list the `todo` tool edits. Paid by
  moving the document's *shape* to its wire owner, `dpi-sdk/src/todos.ts` (TS-104, the reason the client can
  read it without importing backend code), and injecting the *token* through `JobsDeps.todos`, which
  `session-runtime.ts` supplies. `features/jobs/` now imports no sibling feature in either direction, and
  `Phase` still describes everything a handler may do.

Accepted, not fixed, with reasons:

- `Playground` (in `demo.ts`) and `createPlayground` (in `playground.ts`) still share a name. The class
  name is the store split's Q7; renaming it is that plan's decision, not this one's.
- `pause` is one line duplicated in `features/jobs/tools.ts` and `features/side-effects/tool.ts`; a
  third file to hold a `setTimeout` wrapper would cost more than it saves.
