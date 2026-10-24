# Maintainability audit: the playground backend

The clutter is real and it has a shape. New behavior gets appended to three hub files, and each hub already mixes data, behavior, wiring and user-facing text. The todo experiment is a small example of the problem: it touched four backend files across three hubs, when the feature itself is one document, one tool and one job.

This note maps the current responsibilities, proposes a feature-first layout, and gives a migration order that keeps the existing tests green.

## Status

Last checked after `b309916`, on `refactor/store-split`.

- **Step 5 (split the store) is done** and is no longer part of this plan. `store.ts` became ten
  modules plus `device.ts`, the composition root. It landed flat in `src/` rather than in a `store/`
  directory, and the root is accepted on a behavioural guardrail (no SQL, no fs, no harness
  construction, no algorithm) rather than a line count. See `docs/agents/store-split.md`.
- **Open: steps 0, 1, 2, 3, 4 and 6.** Steps 2-4 are the feature split, planned slice by slice in
  `docs/agents/feature-split.md`.
- The feature split landed at `src/playground/features/`, after a later move put the demo and its
  features under `src/playground/`.
- The measurements below are pre-split and stay as written, because they are the argument for the
  layout. `src` is now 4,667 lines, `jobs.ts` 840 and `extensions.ts` 581: the two hub files this
  plan is still about have not shrunk.

## Measurements

`apps/dpi-backend/src` is 4,148 lines. Three files hold most of it:

| File | Lines | What it accumulates |
|---|---:|---|
| `store.ts` | 1,198 | 57 methods spanning catalog, sessions, harness lifecycle, agents, send/abort, tasks, docs, extensions, compaction, demo endpoints, idempotency |
| `jobs.ts` | 840 | job metadata, input validation, a 12-method phase API, 13 phase handlers, run-record helpers, task definitions, approval task, engine |
| `extensions.ts` | 580 | 4 documents, 11 tools, progress formatting, history search bridge, subagent/session tools, handoff, the whole system prompt, extension assembly |

Counts in those files:

- 11 `defineTool` calls in one function, `createPlayground`.
- 4 job definitions and 13 phase handlers in one `HANDLERS` object.
- A single 1,777-character system prompt line in `extensions.ts`.
- `store.ts` has no `defineTool` or `defineTask`, but it is where every feature's persistence and HTTP behavior lands.

The rest of the backend is reasonably sized: `streams.ts` 224, `routes.ts` 182, `history.ts` 165, `addons.ts` 139. `todos.ts` is 39. So the problem is concentrated, not everywhere.

The `store.ts` row and the `store.ts` bullet above describe the file before the store split; `device.ts` (384 lines) is its successor, and the numbers in this section would read 4,667 for `src`, 581 for `extensions.ts` today.

## The pattern behind the clutter

A feature needs four things:

1. a document type and its `defineDoc`;
2. tools that edit it;
3. a task or job that processes it;
4. wiring: registry install, conversation seeding, HTTP exposure, prompt text.

Today those four pieces land in different hubs. Add todo priorities and the next diff touches `todos.ts`, `extensions.ts`, `jobs.ts`, `store.ts` and maybe `routes.ts`, even though it is one feature.

The jobs file shows the same problem inside one dimension. `JOB_DEFS` (metadata), `HANDLERS` (behavior), `phaseApi` (runtime helpers), `defineTask` (task graph) and `runPhase` (engine) all sit in one module. Adding one job means editing three distant regions of the same file.

`store.ts` is a god object. It is simultaneously:

- the SQLite catalog owner and lock holder;
- the filesystem browser for session creation;
- the harness lifecycle manager and recovery loop;
- the agent CRUD and messaging layer;
- the task and document projection layer;
- the extension and compaction settings store;
- the demo HTTP facade;
- the idempotency cache.

None of those are individually large. Together they make every change pass through one class, and they make the class hard to test without booting a server.

## Target layout

Keep the public API and persisted contracts exactly as they are. Move code behind them.

```
apps/dpi-backend/src/
  main.ts                     composition root
  config.ts  auth.ts  errors.ts  contract-check.ts
  shared-state.ts
  streaming/
    streams.ts
    diff.ts
  routes/
    index.ts                  mounts domain routers
    sessions.ts  agents.ts  tasks.ts  docs.ts  demo.ts  device.ts
  store/
    index.ts                  Store facade, open/close, notify
    catalog.ts                sessions/meta/requests/spawns tables, locks
    sessions.ts               create/rename/archive/list/resolve/summary/tree
    agents.ts                 openAgent, scan, create/fork/configure/send/abort
    tasks.ts                  task projection, labels, abort, inspect
    documents.ts              entries/transcript/preview/inbox/doc reads
    extensions.ts             extension selection and addon registry
    compaction.ts
    models.ts                 routing, validation, device info
    idempotency.ts
    demo.ts                   state/job endpoints
  features/
    feature.ts                Feature type and assembler
    app-state/
      doc.ts  tools.ts
    todos/
      doc.ts  tools.ts  job.ts
    jobs/
      types.ts                JobDef, JobModule, Handler
      defs.ts                 JOB_DEFS assembled from modules
      runtime.ts              Phase API, run records, phase engine
      workspace-snapshot.ts
      release-check.ts
      change-watch.ts
      approval.ts
    history/
      search.ts  tool.ts
    sessions/
      subagent.ts  start-session.ts  handoff.ts
    side-effects/
      pager.ts  tool.ts
  playground.ts               prompt sections + extension assembly
```

The tree is a direction, not a quota. The important rules are:

- one job per file, with its metadata, handlers and result shape together;
- one tool family per file, with its document next to it;
- `store.ts` becomes a facade that delegates, so routes and tests keep calling the same methods;
- feature code does not import siblings. It imports `feature.ts`, the store interfaces it needs, and SDK types.

## A feature contract

The current extension API already has the right shape: tools, tasks and sections are arrays. Wrap that in one small type.

```ts
// features/feature.ts
export type Feature = {
  docs?: DocToken<any>[];
  tools?: ToolRegistration[];
  tasks?: TaskDefinition<any, any, any, any>[];
  section?: Section;
};

export const feature = (parts: Feature) => parts;
```

A feature factory receives the dependencies it actually uses, not the whole store. Keep those dependencies in a small type so features never import `store.ts` and the composition stays one-way.

```ts
// features/feature.ts
export type PlaygroundDeps = {
  shared: SharedState;
  sessionId: string;
  spawn: SpawnSession;
  jobs: Jobs;
};
```

```ts
// features/todos/tools.ts
export function todoTools(deps: { sessionId: string }) {
  const todo = defineTool({ /* ... */ });
  return feature({ docs: [Todos], tools: [todo] });
}
```

Assembly stays in one place and preserves order, because tool order is part of the system prompt and prompt-cache behavior.

```ts
// playground.ts
export function createPlayground(deps: PlaygroundDeps) {
  const features = [
    appStateTools(deps),
    todoFeature(deps),
    jobsTools(deps),
    historyTools(deps),
    sessionTools(deps),
  ];
  return defineExtension({
    name: "playground",
    tools: features.flatMap((f) => f.tools ?? []),
    tasks: features.flatMap((f) => f.tasks ?? []),
    sections: [playgroundSection(), ...features.flatMap((f) => (f.section ? [f.section] : []))],
  });
}
```

This keeps one user-visible extension, so the Extensions panel and existing selections do not change. If per-feature toggles are wanted later, each feature can export its own `defineExtension` instead. That is a separate decision, not part of the split.

## A job contract

A job file owns everything about that job.

```ts
// features/jobs/types.ts
export type JobModule = {
  def: JobDef;
  handlers: Record<string, Handler>;
  tasks?: TaskDefinition<any, any, any, any>[];
};
```

```ts
// features/jobs/todo-digest.ts
export const todoDigest: JobModule = {
  def: { id: "todo-digest", /* ... */ },
  handlers: {
    digest: async (p) => { /* ... */ },
  },
};
```

`features/jobs/defs.ts` concatenates the modules in a fixed order. `features/jobs/runtime.ts` keeps `phaseApi`, `runPhase`, `finish`, `fail`, `approvalPhase` and the run-record helpers, and imports no specific job. This removes the two-page jump between a job definition and its handlers.
## Splitting the store

Do not split the class by line count. Split by the reason a method changes:

| Module | Methods |
|---|---|
| `catalog.ts` | schema, locks, `requests`, `session_spawns`, `meta`, `session_compaction` |
| `sessions.ts` | `create`, `rename`, `archive`, `list`, `row`, `resolveSession`, `sessionSummary`, `tree` |
| `agents.ts` | `openAgent`, `harness`, `scanAll`, `resolveAgent`, `agents`, `agentSummary`, `agentDetail`, `setAgentName`, `createAgent`, `fork`, `configure`, `send`, `settled`, `abort`, `withdraw`, `compact`, `reset` |
| `tasks.ts` | `tasks`, `abortTask`, `inspect`, `liveTasks`, `taskNode`, `labelTasks` |
| `documents.ts` | `entries`, `activeEntries`, `transcript`, `preview`, `inbox`, `agentDoc`, `deviceDoc`, `usage` |
| `extensions.ts` | `extensionsOf`, `setExtension` |
| `compaction.ts` | `compactionOf`, `setCompaction` |
| `models.ts` | `deviceInfo`, `routedModel`, `validateModel`, `loadModels`, `directories`, `browse` |
| `demo.ts` | `demoState`, `startJob`, `approveJob` |
| `idempotency.ts` | `replay`, `remember` |

`store/index.ts` keeps the `Store` class and delegates:

```ts
class Store {
  readonly sessions: Sessions;
  readonly agents: Agents;
  // ...
  create(body: CreateSessionBody, spawnKey?: string) {
    return this.sessions.create(body, spawnKey);
  }
}
```

Routes and tests keep their imports. The delegation methods are boring on purpose; that is what makes the split safe.

## Migration order

Each step should be a separate commit and should end with the full backend suite green. The existing tests are mostly end to end, which is exactly what a behavior-preserving refactor needs.

0. **Characterize the contracts.** Add one test that snapshots the offered tool names in order, the job ids in order, and the `demo.todos`/`demo.job-runs` doc responses. This catches accidental renames or reordering that end-to-end tests would miss. No production changes.
1. **Move text out.** Put the system prompt and long tool descriptions in `playground.ts` or a `descriptions.ts`. Pure text move, zero behavior. This removes the 1,777-character line and makes prompt edits reviewable.
2. **Split jobs by job.** Create `features/jobs/`. Move metadata, handlers and result shapes per job. Keep `jobs.ts` as a re-export shim for one commit so nothing else changes. Gate: `npm test`.
3. **Split the phase runtime.** Move `Phase`, `phaseApi`, `runRecord`, `runPhase`, `finish`, `fail`, `approvalPhase` into `runtime.ts`. The job modules should only import `Handler` and `Phase`. Gate: `npm test`.
4. **Split tools by feature.** Move the 11 tools into feature files. Keep `createPlayground` as the assembler. Gate: the new contract snapshot plus `npm test`.
5. ~~**Split the store.**~~ **Done**, outside this plan and in a different shape: ten modules plus
   `device.ts` in `src/`, no `store/` directory, facade by delegation. See
   `docs/agents/store-split.md`.
6. **Split routes by prefix.** Only after the store is smaller. Mount `/sessions`, `/agents`, `/docs`, `/demo`, `/device` routers from `routes/index.ts`. Gate: API tests and hub tests. The store is
   smaller now, so this is unblocked.
7. **Optional frontend pass.** `Inspector.vue` (415), `AgentView.vue` (322) and `client/store.ts` (365) have the same accumulation pattern. Split panels by tab and keep the client store as a facade. This can wait.

Do not combine steps 2 and 4. Both touch extension assembly and both can change tool order, which changes the prompt. One change at a time keeps failures attributable.

## Contracts to preserve

These are persisted or client-visible, so a refactor must not rename them:

- document kinds: `demo.workspace`, `demo.job-runs`, `demo.todos`, `demo.todo-receipt`, `demo.pager`, `demo.receipt`, `ext.system-prompts`
- tool names, including `todo`, `run_durable_job`, `check_durable_job`
- job ids and their phase ids, because run records store both
- SQLite table and column names
- HTTP paths and query parameters
- task definition names such as `demo.job.todo-digest`
- tool order and section order, unless the prompt change is intentional

## What I would not do

- One file per tool. The state tools belong together, as do the session tools. Split by feature boundary, not by `defineTool` count.
- A generic plugin framework with manifests and dynamic discovery. This app has five features, not fifty. Explicit arrays in `playground.ts` are easier to read and debug.
- Renaming documents or tables to match the new folder names. The layout is for humans; the persisted names are for compatibility.
- Moving everything at once. The change would be unreviewable and the tests would only tell you that something broke, not what.

## Acceptance criteria

The refactor is done when:

- no backend source file outside tests and generated data exceeds roughly 300 lines;
- each job's definition and handlers live in one file;
- each tool family lives with its document and has one registration point;
- the composition root is a facade (`device.ts`), and no single module mixes catalog SQL with harness lifecycle;
- the contract snapshot from step 0 is unchanged;
- `npm test` in `apps/dpi-backend` passes, and `just hub test` still passes after the route split.

## Open decisions

1. One `playground` extension assembled from features, or one extension per feature with its own toggle. The first keeps current behavior. The second exposes features in the Extensions panel but changes selection semantics.
2. Co-locate job result shapes with job files, or keep all wire types in `dpi-sdk`. I would keep shared wire types in the SDK and job-private data in the job file.
3. Whether the frontend split belongs in the same effort. I would sequence it after the backend because it has no dependency on the backend layout.
