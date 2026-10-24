# Experiment: a todo document, a tool and a one-phase job

This experiment adds one small vertical slice to the playground:

- a conversation document, `demo.todos`, that holds the todo list;
- a `todo` tool the model can call to edit that document;
- a one-phase durable job, `todo-digest`, that reads the document and writes a summary both to the document and to App State.

It is deliberately small, but it exercises the three things you asked about: tools, tasks and extensions. The engine is the published `@earendil-works/pi-durable` package; everything below is application code in this repo, and it lives in the demo pack, `apps/dpi-demo-backend/src/playground/`, plus one line in the web client's document subscription list.

The experiment is merged into `deploy/sbx` (the merge of `experiment/todos-harden`), and the paths below are checked against the current layout, after the store split and the device-pack split that moved the demo out of `apps/dpi-backend` (see `docs/agents/store-split.md`, `docs/agents/feature-split.md` and `docs/agents/device-pack.md`). A checkout of `experiment/todos-harden` has the older paths.

The point to keep in mind while reading: `apps/dpi-backend` is the device and knows nothing about todos. The pack supplies the document, the tool, the job and the route that serves it, so this experiment is also a worked example of what a pack can add without touching the device.

## Where each piece lives

| File | What changed |
|---|---|
| `apps/dpi-demo-backend/src/playground/features/todos/doc.ts` | New. Defines `Todos` with `defineDoc`, and `TodoReceipt`, the task-scoped receipt the replay guard reads. |
| `apps/dpi-sdk/src/todos.ts` | New. `TODOS_DOC`, `TodoItem`, `TodoDigest` and `TodosDoc`, in the SDK because the client reads the same JSON the pack writes. |
| `apps/dpi-demo-backend/src/playground/features/todos/tools.ts` | New. The `todo` tool, and the `todos()` feature that publishes it. |
| `apps/dpi-demo-backend/src/playground/prompt.ts` | One added sentence in the system prompt, and the `TOOL_DESCRIPTIONS.todo` entry. |
| `apps/dpi-demo-backend/src/playground/features/jobs/todo-digest.ts` | New. The `todo-digest` job definition and its one phase. |
| `apps/dpi-demo-backend/src/playground/features/jobs/{types,phase}.ts` | The phase gains `todos()` and `saveTodoDigest()`; the document token is injected as `JobsDeps.todos` instead of being imported from a sibling feature. |
| `apps/dpi-demo-backend/src/playground/playground.ts` | The feature is added to the conversation's tool list. |
| `apps/dpi-demo-backend/src/playground/pack.ts` | `Todos` is the third conversation document a session seeds, and the token is passed into `createJobs`. |
| `apps/dpi-backend/src/{session-runtime,documents,routes}.ts` | Unchanged by this experiment, and that is the point: the device seeds whatever the pack lists (`session-runtime.ts` calls `documents.seed`) and serves it at `GET /v1/sessions/:s/agents/:a/docs/:kind` (`routes.ts`, read by `documents.agentDoc`). |
| `apps/dpi-demo-backend/src/faux.ts` | Offline model commands for tests: `todos?` and `todo: <action> [arg]`. |
| `apps/dpi-playground/apps/dpi-playground-fe/src/client/composables.ts` | Adds `demo.todos` to `AGENT_DOCS`, so the web client receives live changes. No component renders it yet. |
| `apps/dpi-demo-backend/tests/{api,recovery,contracts}.test.ts` | The API test covers add, complete, list and the digest job; the recovery test covers replay and the SIGKILL restart; the contract test pins the document kinds a client may subscribe to. |

## The data model

The shape is in the SDK, because the client reads the same JSON the pack writes:

`apps/dpi-sdk/src/todos.ts`

```ts
export const TODOS_DOC = "demo.todos";
export type TodoItem = { id: string; text: string; done: boolean; createdAt: number; doneAt?: number };
export type TodosDoc = { items: TodoItem[]; digest?: TodoDigest };
```

The document itself is defined next to the tool that edits it:

`apps/dpi-demo-backend/src/playground/features/todos/doc.ts`

```ts
export const Todos = defineDoc<TodosDoc>({
  kind: TODOS_DOC,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
});
```

`scope: "conversation"` means every conversation (including a subagent's) gets its own list. `history: "rewindable"` keeps older versions for `snapshotAsOf`. `fork: "asOf"` gives a fork the list as it was at the fork point, which matches the existing `Workspace` document.

Nothing in `apps/dpi-backend` names the document. The pack lists it as the third conversation document in `pack.ts` (seeding order is contract: `Workspace`, `JobRuns`, `Todos`), the device runs `documents.seed` from `conversationCreated` (`session-runtime.ts`), so trees, forks and tool-created conversations all start with an empty list. `tx.doc(Todos, ...)` would also create it on first touch, so older sessions in an existing SQLite file are fine.

## The tool

`todo` is a module-level tool (`TodoTool` in `apps/dpi-demo-backend/src/playground/features/todos/tools.ts`): it closes over nothing, so one definition serves every session and a test can call `execute` directly. It takes an `action`:

| Action | Needs | Effect |
|---|---|---|
| `list` | nothing | Returns JSON with `open`, `done` and the items, including ids. |
| `add` | `text` | Appends an item. The item id is `t<taskId>`. |
| `complete` | `id` | Sets `done` and `doneAt`. |
| `reopen` | `id` | Clears `done` and `doneAt`. |
| `remove` | `id` | Drops the item. |

The whole action runs in one `api.commit`, together with a task-scoped receipt:

```ts
const receipt = await tx.doc(TodoReceipt, api.taskId);
if (receipt.applied) return receipt.result;
const doc = await tx.doc(Todos, api.conversationId);
// ...edit doc.items...
receipt.applied = true;
receipt.result = out;
```

Two durable properties follow from that:

- The list edit and the tool result are one transaction. A crash cannot leave the list changed but the model uninformed, or the other way around.
- The tool is declared `replay: "safe"`, so a call interrupted by a crash reruns after reopen. The receipt makes the rerun return the first result instead of adding the same item twice or toggling twice.

`list` also writes a receipt, which is harmless and keeps the code on one path. The item id doubles as a second guard: `add` skips an item whose id is already in the list, so even a lost receipt cannot duplicate that one action.

## The job

`todo-digest` is one phase, so it also shows the minimum shape of a task definition:

```ts
{
  id: "todo-digest",
  title: "Todo digest",
  summary: "Read this conversation's todo list in one checkpointed phase, save a one-line digest on the list and in App State.",
  phases: [{ id: "digest", label: "Digest", summary: "Count open and done items and name the oldest open one" }],
  inputs: [],
  approval: false,
  resultPath: "/jobs/todo-digest",
  seconds: 2,
}
```

The phase handler uses the existing job phase API and records two steps:

1. a `note` step that reads the conversation document;
2. a `state` step that calls `p.saveState("/jobs/todo-digest", ...)` and `p.saveTodoDigest(...)`.

The second call is the interesting one. It commits the digest onto `demo.todos` in the task's own commit, which is how a task writes a conversation document. The job still follows the existing convention of saving its result to App State at `resultPath`, so `list_durable_jobs` and `check_durable_job` remain truthful. An empty list short-circuits before that step: the run reports "Todo list is empty" and leaves the document alone rather than storing a digest of nothing.

The new phase helpers are thin wrappers around the task runtime. The document token arrives through `JobsDeps`, so the jobs directory never imports the todos feature:

```ts
todos: async () => (await runtime.snapshot(deps.todos, task.conversationId, ctx)) ?? { items: [] },
saveTodoDigest: (digest) =>
  runtime.commit(async (tx) => {
    (await tx.doc(deps.todos, task.conversationId)).digest = digest;
    return undefined;
  }, ctx),
```

Because the phase commits before returning, a restart mid-phase resumes from the phase checkpoint. Steps recorded by the interrupted iteration are replaced when the phase reruns, as with the other jobs.

## Trying it

Start the backend in one terminal and a client in another:

```bash
just demo dev         # tsx watch on the demo device; restarts on src changes
just hub start        # http://localhost:4781
just tui attach local # or drive it from the terminal
```

`just backend dev` runs the bare device, which has no todo tool: the document, the tool and the job are the pack's, so they do not exist there.

In any playground conversation, ask:

```text
add "write the experiment" to my todo list
show my todos
complete t<id>
run the todo-digest job
```

Or use the offline model, which does not need a provider key (`DPI_PROVIDER=faux`):

```text
todo: add write the experiment
todos?
todo: complete t<id>
job: todo-digest
```

The job also shows up in the Tasks tab, because the device's job list comes from `JOB_DEFS`.

To read the document directly:

```bash
curl -s -H "Authorization: Bearer $DPI_TOKEN" \
  "http://localhost:4780/v1/sessions/<session>/agents/main/docs/demo.todos" | jq
```

(`$DPI_TOKEN` is the token written to `~/.dpi/backend.env` by `just net up local`. A session ref is its id or a unique name; `main` is the root agent.)

## Deploying it to the sandbox device

The device image bakes the apps into `/opt/durable-pi` at build time, so recreating the sandbox is the
only way to keep this experiment on a device. For trying it on an existing `sbx` device, stream the
changed source into the sandbox and restart the backend there. `sbx` is not available inside this
sandbox, so these commands come from the kit and the device script (`sbx/durable.dockerfile`,
`sbx/scripts/durable.sh`) and were not run here; the sandbox name is the device id.

```bash
# 0. Locally first: types and tests, so a break never reaches the device.
cd apps/dpi-demo-backend && ./node_modules/.bin/tsc --noEmit -p . && npm test && cd ../..

# 1. Stream both apps into the device: the device answers the route, the pack owns the todos, so a
#    change to either has to land. /opt/durable-pi is root-owned, hence sudo.
for app in dpi-backend dpi-demo-backend; do
  tar -C "apps/$app" -czf - src |
    sbx exec device-a sh -c "sudo tar -xzf - -C /opt/durable-pi/apps/$app"
done
```

The demo app imports the device by relative path, so the image keeps them siblings under
`/opt/durable-pi/apps`, and the device starts from `apps/dpi-backend` with `DPI_PACK` pointing at the
demo pack (`sbx/scripts/durable.sh`).

```bash
# 2. Restart the backend on the new code. Not `durable start`: that rewrites ~/.dpi/backend.env from
#    the current environment, and an exec shell without the device's DPI_MODEL or provider key would
#    quietly move it to faux. dpi-backend reads ~/.dpi/backend.env itself (loadConfig), so start it the
#    way the boot hook does, against the env file that already holds the token, provider and model.
sbx exec device-a sh -c '
  kill "$(cat "$HOME/.dpi/backend.pid")" 2>/dev/null || true
  sleep 1
  cd /opt/durable-pi/apps/dpi-backend
  setsid node_modules/.bin/tsx src/main.ts >>"$HOME/.dpi/backend.log" 2>&1 &
  echo $! >"$HOME/.dpi/backend.pid"
'
```

No dependency changed, so no `npm ci` and no image build: the image's `node_modules` still matches
`src`. Nothing in either step touches `~/.dpi/backend`, where the sessions and their checkpoints live.

This is not `just net deploy device-a`: the network CLI has no deploy step for `kind: url` devices —
the hub knows a URL and a token, and it must never reach into a sandbox. That is the same boundary
`sbx/enroll.sh` documents from the other side.

### Verify

```bash
sbx exec device-a sh -c 'curl -fsS http://127.0.0.1:4780/healthz; echo'
# {"ok":true}
```

```bash
# demo.todos for the first session's root agent: the items and the last digest, or {"items":[]} on a
# device that has never run a todo call. The token stays inside the sandbox.
sbx exec device-a sh -c '
  set -a; . "$HOME/.dpi/backend.env"; set +a
  S=$(curl -fsS -H "Authorization: Bearer $DPI_TOKEN" http://127.0.0.1:4780/v1/sessions | jq -r ".[0].id")
  curl -fsS -H "Authorization: Bearer $DPI_TOKEN" \
    "http://127.0.0.1:4780/v1/sessions/$S/agents/main/docs/demo.todos" | jq .
'
```

Then drive it once through the hub (`just hub start`, port 4781) or `sbx exec device-a durable attach`:
`todo: add ...`, `todos?`, `job: todo-digest`. Read the document again and the item and digest are
there. Kill the backend once more and read it after it is back: same list, same digest, because both
come from `~/.dpi/backend/sessions/<uuid>/agent.sqlite` and the deploy never touches that folder.

The web client change is not on the device: the hub serves the SPA, so `just hub build` and restart the
hub. The device only needs to answer the `docs=demo.todos` subscription the hub forwards.

Two operational notes:

- The stream is a one-way copy. A file deleted here stays in `/opt/durable-pi/.../src` until the next
  rebuild, and a sandbox recreated from the image loses the whole stream and goes back to the baked
  source. For a lasting device, `just kit build` and recreate it (see `sbx/SETUP.md` step 2).
- If your `sbx exec` does not forward stdin, copy from the mounted workspace instead; the kit mounts
  the checkout at the image's working directory:

  ```bash
  for app in dpi-backend dpi-demo-backend; do
    sbx exec device-a sh -c \
      "sudo cp -a /home/agent/workspace/apps/$app/src/. /opt/durable-pi/apps/$app/src/"
  done
  ```

  (that sandbox must be the one created on this checkout).

No script: the two steps above are the whole procedure, and a wrapper that cannot be exercised in this
environment would only give the paths another place to drift.

## What to watch

- **Disconnect:** close the browser or detach the TUI after asking for an add. Reconnect; the item and the tool result are still there.
- **Restart:** stop the backend, start it again, refresh the hub. The list and the last digest come back from SQLite.
- **Fork:** fork the conversation. The fork starts with the list as of the fork entry (`fork: "asOf"`), and edits in either branch do not touch the other.
- **Two writers:** run `todo-digest` while another agent edits the list. The digest records the counts at its commit; no partial state is visible.
- **Live stream:** with `just hub dev`, the `demo.todos` frames arrive on the agent stream next to `demo.job-runs` and `demo.workspace`. Nothing renders them yet, but `agentState.docs["demo.todos"]` in the client store stays current.

## Tests

The API test drives the tool through the faux model and then runs the job:

```bash
cd apps/dpi-demo-backend
./node_modules/.bin/tsc --noEmit -p .
./node_modules/.bin/tsx --test tests/api.test.ts
npm test
```

The new assertions check the item text and id, the completed flag, the `list` output, and the digest fields (`open: 0`, `done: 1`) written onto `demo.todos` by the job.

`apps/dpi-demo-backend/tests/recovery.test.ts` covers the two properties a restart is supposed to give:

- **Replay:** `TodoTool.execute` is called twice under one live task id — the state a tool call is in
  when the engine reruns it after a crash — and the list gains one item, `complete` keeps its first
  `doneAt`, and a replayed `remove` reports the removal instead of failing on the item it already
  dropped. Each simulated call mints a small live task, because the document layer only accepts
  task-scoped writes while that task is not terminal; `add` is additionally guarded by its id, so the
  removal replay is the assertion that a missing receipt would break.
- **Restart:** a real device process adds an item, completes it and runs `todo-digest`, then takes
  `SIGKILL`. After restart, `demo.todos` still holds the same items and digest, and the run is still
  `completed` in `demo.job-runs`.

Both are part of `npm test`.

## Extending it

- Add a `priority` field in `apps/dpi-sdk/src/todos.ts`, a tool argument in `apps/dpi-demo-backend/src/playground/features/todos/tools.ts`, and a sort in the digest phase. The types are shared with the client, so the compiler points at every place that needs the field.
- Add a `todo-archive` job with two phases: write an archive to App State, then remove completed items in a checkpointed second phase. Aborting it demonstrates bottom-up task cancellation.
- Add a hook in a new extension that blocks `todo` `remove` while a `demo.frozen` document is set. Hooks receive tool calls before they run; see `addons.ts` for a `beforeTool` example.
- Add the list to the web UI next to `StateEditor.vue` by reading `demo.todos` through the existing docs endpoint.

## Reverting

The experiment is merged into `deploy/sbx`. Its original commits are `7709cb7` and `591a080` on
`experiment/todos-harden`, merged in `05e9090`; the device-pack split then moved the files from
`apps/dpi-backend/src` into the demo pack without changing what they do.

Reverting is a subtraction at the pack edge, not a branch operation, and nothing in `apps/dpi-backend`
has to change:

1. Drop the `Todos` entry from the conversation documents in `pack.ts` and the `todos` argument in
   `createJobs`, then delete `features/todos/`.
2. Delete `apps/dpi-demo-backend/src/playground/features/jobs/todo-digest.ts` and its entry in the job
   list, and the `todos()` and `saveTodoDigest()` helpers in
   `apps/dpi-demo-backend/src/playground/features/jobs/phase.ts`.
3. Delete the `todo` entry from `prompt.ts` and from the tool list in `playground.ts`.
4. Delete `apps/dpi-sdk/src/todos.ts`, the `demo.todos` entry in `composables.ts`, and the faux commands.

Reverting the two original commits and re-resolving the move reaches the same place, with more work.

Existing session databases keep the `demo.todos` and `demo.todo-receipt` rows, but nothing reads them, so they are inert.
