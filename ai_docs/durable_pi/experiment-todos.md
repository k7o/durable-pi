# Experiment: a todo document, a tool and a one-phase job

This experiment adds one small vertical slice to the playground backend:

- a conversation document, `demo.todos`, that holds the todo list;
- a `todo` tool the model can call to edit that document;
- a one-phase durable job, `todo-digest`, that reads the document and writes a summary both to the document and to App State.

It is deliberately small, but it exercises the three things you asked about: tools, tasks and extensions. The engine is the published `@earendil-works/pi-durable` package; all changes are application code in this repo, mostly in `apps/dpi-backend` plus one line in the web client's document subscription list.

## Files changed

| File | What changed |
|---|---|
| `apps/dpi-backend/src/todos.ts` | New. Defines `Todos` with `defineDoc`, plus the `TodoItem`, `TodoDigest` and `TodosDoc` types. |
| `apps/dpi-backend/src/extensions.ts` | New `TodoReceipt` task document (:48), new `todo` tool (:56), tool added to the playground extension (:561), one added sentence in the system prompt (:575). |
| `apps/dpi-backend/src/jobs.ts` | New `todo-digest` job definition (:122), a handler at (:337), and two phase helpers: `todos()` and `saveTodoDigest()` (:179, :522). |
| `apps/dpi-backend/src/store.ts` | Seeds `Todos` for every new conversation (:529) and exposes `demo.todos` through `GET /v1/sessions/:s/agents/:a/docs/:kind` (:102). |
| `apps/dpi-backend/src/faux.ts` | Offline model commands for tests: `todos?` and `todo: <action> [arg]`. |
| `apps/dpi-playground/apps/dpi-playground-fe/src/client/composables.ts` | Adds `demo.todos` to the agent stream's document list, so the web client receives live changes. No component renders it yet. |
| `apps/dpi-backend/tests/api.test.ts` | Covers add, complete, list and the digest job, including its document writes. |
| `apps/dpi-backend/tests/recovery.test.ts` | Covers the receipt under replay (one add, one toggle, one removal) and `demo.todos` plus its digest across a SIGKILL restart. |

## The data model

`apps/dpi-backend/src/todos.ts`

```ts
export type TodoItem = { id: string; text: string; done: boolean; createdAt: number; doneAt?: number };
export type TodosDoc = { items: TodoItem[]; digest?: TodoDigest };

export const Todos = defineDoc<TodosDoc>({
  kind: "demo.todos",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ items: [] }),
});
```

`scope: "conversation"` means every conversation (including a subagent's) gets its own list. `history: "rewindable"` keeps older versions for `snapshotAsOf`. `fork: "asOf"` gives a fork the list as it was at the fork point, which matches the existing `Workspace` document.

`store.ts` creates the document in `conversationCreated`, so trees, forks and tool-created conversations all start with an empty list. `tx.doc(Todos, ...)` would also create it on first touch, so older sessions in an existing SQLite file are fine.

## The tool

`todo` is a module-level tool (`TodoTool` in `extensions.ts`): it closes over nothing, so one definition serves every session and a test can call `execute` directly. It takes an `action`:

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

The new phase helpers are thin wrappers around the task runtime:

```ts
todos: async () => (await runtime.snapshot(Todos, task.conversationId, ctx)) ?? { items: [] },
saveTodoDigest: (digest) =>
  runtime.commit(async (tx) => {
    (await tx.doc(Todos, task.conversationId)).digest = digest;
    return undefined;
  }, ctx),
```

Because the phase commits before returning, a restart mid-phase resumes from the phase checkpoint. Steps recorded by the interrupted iteration are replaced when the phase reruns, as with the other jobs.

## Trying it

Start the backend in one terminal and a client in another:

```bash
just backend dev      # tsx watch; restarts on src changes
just hub start        # http://localhost:4781
just tui attach local # or drive it from the terminal
```

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
cd apps/dpi-backend && ./node_modules/.bin/tsc --noEmit -p . && npm test && cd ../..

# 1. Stream this checkout's backend source into the device. /opt/durable-pi is root-owned, hence sudo.
tar -C apps/dpi-backend -czf - src |
  sbx exec device-a sh -c 'sudo tar -xzf - -C /opt/durable-pi/apps/dpi-backend'
```

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
  sbx exec device-a sh -c \
    'sudo cp -a /home/agent/workspace/apps/dpi-backend/src/. /opt/durable-pi/apps/dpi-backend/src/'
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
cd apps/dpi-backend
./node_modules/.bin/tsc --noEmit -p .
./node_modules/.bin/tsx --test tests/api.test.ts
npm test
```

The new assertions check the item text and id, the completed flag, the `list` output, and the digest fields (`open: 0`, `done: 1`) written onto `demo.todos` by the job.

`tests/recovery.test.ts` covers the two properties a restart is supposed to give:

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

- Add a `priority` field in `todos.ts`, a tool argument, and a sort in the digest phase. The document is typed, so the compiler points at every place that needs the field.
- Add a `todo-archive` job with two phases: write an archive to App State, then remove completed items in a checkpointed second phase. Aborting it demonstrates bottom-up task cancellation.
- Add a hook in a new extension that blocks `todo` `remove` while a `demo.frozen` document is set. Hooks receive tool calls before they run; see `addons.ts` for a `beforeTool` example.
- Add the list to the web UI next to `StateEditor.vue` by reading `demo.todos` through the existing docs endpoint.

## Reverting

The experiment lives on `experiment/todos-harden`, cut from `deploy/sbx`: the baseline (document, tool,
job, API test, this note) and the hardening on top (the replay and restart tests, the deploy runbook).
So `deploy/sbx..experiment/todos-harden` is exactly this experiment. Drop the branch, or undo both
commits on it, newest first:

```bash
# drop it
git switch deploy/sbx && git branch -D experiment/todos-harden
# or keep the branch and undo the two commits
git revert --no-edit $(git log --format=%H deploy/sbx..experiment/todos-harden)
```

What those commits own, if you pick them apart by hand: `apps/dpi-backend/src/todos.ts` and
`ai_docs/durable_pi/experiment-todos.md` are new; `apps/dpi-backend/src/{extensions,jobs,store,faux}.ts`,
`apps/dpi-backend/tests/{api,recovery}.test.ts` and the web client's `composables.ts` are edited.

Existing session databases keep the `demo.todos` and `demo.todo-receipt` rows, but nothing reads them, so they are inert.
