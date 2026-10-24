# TypeScript coding standards

Applies to TypeScript written for Pi and Durable Pi: extensions, custom tools, providers, SDK
integrations, and the apps under `apps/`. Rule IDs are stable so a review can cite one without
quoting prose. Verified against `durable-pi@05e9090` on 2026-10-23.

## How to use this document

This document is reference material for a code review. Read a rule as the target behavior, not as
a suggestion. A finding names one rule, one location, and one fix.

### Severities

| Severity | Use for | Merge effect |
|---|---|---|
| blocker | Ships a bug, loses data, leaks a secret, breaks a Pi or persistence contract, or fails the build | Fix before merge |
| major | Likely bug under real conditions, or a contract the next change will trip over | Fix here or file it |
| minor | Local robustness or readability problem | Fix when cheap |
| nit | Preference | Never blocks; at most two per review |

### Finding format

Example of the shape, not a claim about this repo:

```
[TS-303] src/routes.ts:12 major
Problem: `limit` is read from the query string and reaches the store without a bound.
Fix: parse it with int(), clamp it to 1,000, and reject values below 1 with invalid("limit must be between 1 and 1000").
```

### Review order

1. Read the package's `tsconfig.json` and `package.json`. Done when you know the module mode, the
   strictness flags, and which checks the compiler already runs.
2. List the contracts the diff touches: HTTP bodies, stream frames, doc kinds, tool names, table
   columns, file formats. Done when each one has a named owner type and you know whether the change
   breaks an existing shape.
3. Check Pi integration points: extension factory, event handlers, tools, providers, session
   lifecycle. Done when each changed handler matches its declared input, output, and cleanup path.
4. Check failure and cancellation paths. Done when every new `await` has a signal or a stated
   timeout, and every new resource has a close.
5. Check tests for the edges the diff touches. Done when replay, abort, restart, and concurrent
   access are covered wherever the change can hit them.
6. Scan structure, naming, and comments last. Done when no more than two nits remain.

### Scope of a finding

Findings cover changed lines and code the change makes wrong. Pre-existing debt stays out unless
the diff makes it worse. Skip generated output, `node_modules`, `dist`, and `sbx/build`.

A file's existing size is not a finding. A new responsibility added to a file already over the
guideline is, and so is a change that makes the file harder to split later.

### Rule precedence

A refactor plan can set a stricter bar for the files it covers. When it does, the plan's acceptance
criteria govern those files and these rules govern everything else. Cite the plan by path in the
finding. A plan never lowers a rule: it can demand more than this document, not less.

## Repository baseline

The repo enforces type-level rules with `tsc` and documents none of them. Checked on
2026-10-23:

- Every app sets `strict: true` and `noEmit: true`. Node packages use `target: ES2023` with
  `module: NodeNext`; the Vue frontends use ES2022 with `ESNext` and bundle through Vite.
- ESM everywhere (`"type": "module"`). Node packages import with `.js` specifiers
  (`dpi-sdk`, `dpi-backend`, the playground hub). The TUI and the frontends import `.ts` where
  `allowImportingTsExtensions` is on.
- Tests are `node:test` with `assert/strict`, run through `tsx --test`. 38 test cases.
- 109 TypeScript files contain zero `any` and zero `enum`.
- Ten empty `catch {}` blocks exist, each dropping a failure whose outcome is already handled or
  irrelevant: cleanup, retry loops, best-effort directory and origin parsing.
- Formatting is consistent but unenforced outside `apps/dpi-playground` (`oxlint` 1.87,
  `oxfmt` 0.72): 2-space indent, double quotes, semicolons, trailing commas.
- Pi's upstream examples use tabs; the extensions installed in `~/.pi/agent` mix tabs and 2 spaces.
  Both styles are established; follow the file you are editing and never reformat a file you
  touched only for a fix.
- There is no CONTRIBUTING guide, no root lint or format config, and no CI style gate. `just check`
  runs type checks, unit tests, the web build, and the playground lint.

Gaps this document covers: Pi lifecycle and tool contracts, durable replay rules, persisted-name
compatibility, and the severity vocabulary a review needs.

Known debt: `jobs.ts` (840 lines) and `extensions.ts` (581) in `dpi-backend` exceed the size guideline
in TS-701. `store.ts` was split into `device.ts` and ten modules, so it is no longer one of them. See
`ai_docs/durable_pi/maintainability-audit.md` and `docs/agents/feature-split.md`. The existing size is
not a finding; review each change on what it adds to those files.

## TS: types and contracts

### TS-101 No `any` at trust boundaries · blocker

`any` switches off checking for every value that flows out of the annotation, so a wrong shape
becomes a crash far from the cause. Name the real type, or accept `unknown` and narrow it in one
place.

```ts
// bad: the body's shape is now unchecked everywhere downstream
const body = await req.json() as any;

// good: one parse, one typed result, one error message
const body: unknown = await req.json();
const input = parseCreateAgent(body);
```

One exception: a registry that holds documents or tasks of different types needs a single named
alias at that boundary. Confine it to the registry file, give it a comment, and keep `any` out of
every signature and call site. Use a precise alias when one exists; the task definition below has
no common supertype, so it is the one place `any` is allowed.

```ts
// features/feature.ts: the one place a heterogeneous registration is allowed
type AnyDoc = DocToken<JsonObject, DocDefinition<JsonObject>>;
type AnyTask = TaskDefinition<any, any, any, any>; // no precise common supertype exists
```

Design sketches are not code. The audit's `DocToken<any>[]` is shorthand and does not compile as
written, because `DocToken` takes two type parameters. Give the implementation a real alias and
comment why it is the exception.

### TS-102 Narrow `unknown` in catch clauses · major

Under `strict`, a caught value is `unknown`. Check `instanceof Error` first, then use a type guard.
Rethrow domain errors unchanged so callers keep the code they branch on.

```ts
catch (e) {
  if (isDpiError(e)) throw e;
  throw new DpiError("internal", "Unexpected response", response.status, { cause: e });
}
```

### TS-103 Model variants as string unions, not enums · minor

String-literal unions plus `as const` tables erase cleanly, survive isolated modules and type
stripping, and serialize as the values clients already expect. Close exhaustive switches with a
local `assertNever` so a new variant fails the build. For TypeBox schemas, use `StringEnum` from
`@earendil-works/pi-ai`.

```ts
export type WhenBusy = "followUp" | "steer" | "reject";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
```

### TS-104 One owner for each wire contract · major

Define a JSON shape once, next to its producer, and import it everywhere else. In this repo
`dpi-sdk/src/api.ts` is that owner for the network contract; the backend and every client import
it. Two copies drift and the compiler stops noticing. Use `interface` for object contracts that
callers may extend, type aliases for unions and derived shapes. No `I` prefix.

### TS-105 Keep shared defaults immutable · minor

Tables and literal config use `as const`; object configs use `satisfies` so keys stay checked
without widening. Constructor-injected collaborators are `readonly`. Mutating shared module config
at startup makes behavior depend on import order.

## TS: modules and dependencies

### TS-201 One import style per package · minor

Relative imports carry the extension the package's `tsconfig` resolves: `.js` under NodeNext,
`.ts` where `allowImportingTsExtensions` is on, which in this repo covers the TUI and the Vite
frontends. Never mix both inside one package, and never omit the extension. The compiler catches a
wrong specifier; the review only flags the mix.

### TS-202 Type-only imports use `import type` · minor

`import type` and `export type` state the intent and keep type-only modules out of the runtime
graph. Pi packages are ESM and re-export many types; a value import of one is a runtime edge that
does not exist.

### TS-203 No work at module load · major

Top level defines values. It does not read env, open files or sockets, start timers, or exit the
process. Pi loads extensions in processes that never start a session, so a top-level read can break
`--help` or the config command. Put that work in `session_start`, in a factory, or in an explicit
`main()` that the entry point calls.

### TS-204 Dependencies are pinned and justified · major

Pi packages are pinned exactly (`"1.0.3"`, no caret); a caret lets a transitive change alter tool
behavior between installs. `dpi-sdk/src` keeps zero runtime dependencies and Node-only code lives
under `src/node`. A new dependency for one helper needs a reason in the PR: what the alternative
costs in code, and who maintains the package.

### TS-205 Import from the module that owns a symbol · minor

Barrels hide load order and create cycles. Feature modules import `feature.ts`, the store
interfaces they need, and SDK types; they do not import sibling features. See the target layout in
`ai_docs/durable_pi/maintainability-audit.md`.

## TS: errors and failure

### TS-301 Failures carry a code, a message, and a cause · major

A typed error lets callers branch without parsing text. Map codes to transport status in one place
(`dpi-backend`'s `STATUS` table), not at each throw site, and pass `{ cause }` when wrapping.

```ts
class ApiFault extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.status = STATUS[code];
  }
}
```

### TS-302 Empty `catch` only for best-effort cleanup · major

A cleanup, shutdown, or retry loop may ignore a failure that cannot change the outcome. Anywhere
else, an empty catch hides a bug. When the reason is not visible from the line, write one comment
saying why the failure is safe to drop.

```ts
const close = () => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch { /* best effort: a failed cleanup must not block the rest */ }
  }
};
```

### TS-303 Validate where data enters · major

Parse and validate once at the boundary: HTTP body, query and path params, JSON files, tool
arguments, env. Throw a typed invalid error that names the field. `Number(x)` and `String(x)`
scattered through handlers lose the field name and the check.

```ts
const int = (value: unknown, name: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw invalid(`${name} must be an integer`);
  return n;
};
```

### TS-304 Fail loudly on impossible states · minor

An `else` that cannot happen should fail in development and stay total for the compiler:
`assertNever`, a thrown invariant error, or a `never` assignment. A silent fallback turns a wiring
mistake into plausible wrong data.

### TS-305 Messages are actionable and safe to show · major

Messages reach the model, the CLI user, or an API client. Say what failed and what to do next
(`"No todo item t9. Use action list for ids."`). Keep tokens, authorization headers, credentials
in URLs, file contents, and provider payloads out of every message and stack.

## TS: async, cancellation, resources

### TS-401 Plumb the abort signal · major

Every call that can outlive the operation takes an `AbortSignal`. Combine the caller's signal with
a timeout using `AbortSignal.any`, check `aborted` after an `await` before doing more work, and
rethrow the abort cause rather than reporting it as a network failure.

```ts
const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
```

### TS-402 No floating promises · major

Every promise is awaited, returned, or explicitly discarded with `void` and a reason. Node
terminates the process on an unhandled rejection by default, and tests can swallow it. Work that
runs without an `await` still needs an owner that can cancel it before shutdown.

### TS-403 Release resources in `finally`, idempotently · major

Acquire and release in one place, and make close safe to call twice. Cancellation, reload, session
replacement, and process exit can all reach the same cleanup path. Close servers, streams,
intervals, file handles, and subscriptions; unsubscribe in the SDK's `finally`.

### TS-404 Bound queues, buffers, and fan-out · major

Every queue has a ceiling and a response when it is hit: reject, drop the oldest, or close the
connection. `streams.ts` ends a slow SSE viewer once buffered output passes 2 MB. An unbounded
`Promise.all` over an untrusted list is a finding, not a convenience.

## PI: extension lifecycle

### PI-101 The factory registers; `session_start` starts · major

The default export receives `ExtensionAPI` and registers tools, commands, flags, shortcuts, event
handlers, providers, and MCP servers. Pi loads extensions during `--help` and in modes without a
session, so processes, sockets, watchers, and timers belong in `session_start` or in the command or
tool that needs them. An async factory is allowed, but keep it to reads that registration needs.

### PI-102 Close in an idempotent `session_shutdown` · major

Every session-scoped resource closes in `session_shutdown`. Cleanup runs more than once when
cancellation, reload, session replacement, and exit converge, so a second call must not throw or
double-free.

### PI-103 Drop captured state after reload or session replacement · major

After `await ctx.reload()` the old runtime is gone. Do not reuse closures, timers, or contexts
captured before it. Session replacement invalidates the old `ExtensionContext`: capture plain data
before switching and use the fresh context passed to `withSession`. The SDK has the same rule:
`session.dispose()` and runtime replacement invalidate subscriptions, which must be rebound to the
new session.

### PI-104 Use the result type each event declares · major

`before_agent_start` changes prompt sections, tools, or guidelines. Returning `systemPrompt` or
setting `forceSystemPrompt` replaces the whole prompt and costs the cached prefix, so use it only
for a deliberate full replacement. `message_end` replacements keep the original role. `tool_result`
handlers compose, and each sees prior changes. `provider_stream_event` is notification-only and
read-only. Returning a result from an event that ignores return values is a no-op.

### PI-105 Guard continuations · blocker

`turn_end` and `agent_before_settle` accept `continue: true` for exactly one more model request.
The guard must be state that changes: an attempt counter, a no-progress check, a one-shot flag. An
unconditional continuation loops until the context limit.

### PI-106 Core behavior works without a UI · major

Extensions load in interactive, RPC, JSON, and print modes. Tools and event handlers must work with
no UI. Terminal-only code sits behind `ctx.mode === "tui"`; dialogs and notifications that RPC can
forward sit behind `ctx.hasUI`. An unconditional `ctx.ui.confirm` hangs print mode.

### PI-107 Keep event dispatch fast · minor

Handlers are awaited in order, and provider stream events are awaited in stream order, so a slow
handler delays consumption of the response. Move disk, network, and CPU-heavy work out of hot
events, or hand it to owned background work with a shutdown path.

## PI: tools and model-facing output

### PI-201 A tool declares its contract and returns both halves · major

A tool is `{ name, description, parameters: TypeBox, execute }`. `pi-coding-agent` also takes a
`label`. The name is stable and model-visible; the description says when to call it; the result
always carries model-facing `content` and a `details` value (`undefined` when there is none).
`details` must be small JSON that reconstructs state on resume or fork, never a transcript dump.

Two tool APIs exist. `pi-coding-agent` calls
`execute(toolCallId, params, signal, onUpdate, ctx)`; `pi-durable` calls `execute(args, api, ctx)`.
Match the API you import, and do not copy a signature across.

### PI-202 Pick the right failure channel · major

Throw when the call failed; the harness turns it into an error result. Return `isError: true` with
`structuredContent` when the failure still carries data that scripts should receive. Ask to
terminate only when every result in the batch agrees: `terminate: true` on a `pi-coding-agent`
tool, `control: { terminate: true }` on a `pi-durable` tool. One tool cannot end the run. Returning
an object never marks failure.

### PI-203 `outputSchema` and `structuredContent` agree · major

A tool that declares `outputSchema` must return a matching `structuredContent` on every path,
including failures returned as data. Codemode scripts read `structuredContent`; text-only callers
read `content`. A mismatch stays invisible until a script crashes.

### PI-204 Truncate with a pointer to the rest · major

Model-facing output has a budget. Truncate with an explicit marker and say where the full output
lives: a file path, a follow-up tool, or `full_output_path`. Silent truncation teaches the model
wrong facts about the result.

### PI-205 Annotations and exposure match behavior · minor

`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` describe what the tool
does; a permission extension may gate calls on them. Choose `exposure` deliberately: `direct` for
the model, `codemode` for scripts, `deferred` for search, `hidden` to withdraw. Group related tools
with `namespace` instead of prefixing names by hand.

### PI-206 Serialize shared state and queue file mutations · blocker

Tool calls from one assistant message can run in parallel. A tool that shares mutable in-memory
state declares sequential execution. A file-mutating tool wraps the whole read-modify-write in
`withFileMutationQueue()`. Event handlers must not assume a sibling call or its result happened.

### PI-207 Report usage from nested model calls · major

A tool that makes nested model calls adds their usage to its result. Without it, session totals and
cost undercount. Pi already adds nested tool usage, so report only the model calls your tool makes.

### PI-208 Descriptions and order are prompts · minor

Tool descriptions and the order in which tools and sections are declared are both prompt text. A
description says when to call the tool, what the arguments mean, and what a good result looks
like. Keep descriptions stable across runs so the prompt cache survives: no timestamps, ids, or
volatile counts. When a change reorders tools or sections, treat it as a prompt change, update the
contract snapshot, and say so in the PR. Longer guidance belongs in `namespace.instructions`, not
in the description.

## PI: providers and streams

### PI-301 One terminal event, one concrete stop reason · blocker

Emit exactly one `done` or `error` and close the stream. Set a concrete `stopReason`; error and
aborted messages carry `errorMessage`. A path that can both finish and error leaves consumers
waiting forever or applying half a response.

### PI-302 Usage, cost, and abort results are accurate · major

Fill input, output, cache, and total tokens plus cost on every assistant message, including aborted
ones. Convert cancellation into an aborted result, not an error. Normalize an unknown
context-overflow response only in a guarded `message_end` handler for that provider.

### PI-303 Pass the signal and provider env; log no secrets · blocker

Pass the caller's abort signal through network calls and honor provider-scoped environment.
Credentials, OAuth codes, prompts, and raw payloads never reach a log, an error message, or
telemetry. A provider extension handles secrets, so treat it as trusted code and keep it small.

### PI-304 Reuse the package's stream conversion · major

Before writing a stream parser, use the existing message conversion and tool-call assembly. A
hand-rolled stream loses usage accounting, cancellation, and compatibility fixes. Copying a known
implementation is safer than inventing one.

## DP: durable state

### DP-101 Choose storage by how state participates · major

| State | Storage |
|---|---|
| Tool state that follows the active branch | tool result `details` |
| Durable data outside model context | `pi.appendEntry()` or a document |
| Content the model should see | `pi.sendMessage()` |
| Data that outlives one session | external storage |

In `pi-durable`, documents defined with `defineDoc` carry state committed with entries. Choose by
participation in the conversation, not by convenience.

### DP-102 Rebuild branch state at `session_start` · major

Reconstruct from `ctx.sessionManager.getBranch()` or a harness snapshot, not by replaying every
entry in storage. Abandoned branches are alternative histories; replaying them corrupts counters
on resume, reload, and fork.

### DP-103 Make replay-safe effects idempotent · blocker

A tool declared `replay: "safe"` reruns after a crash, so it must produce the effect once. Record a
receipt keyed by the task id and return the first result on replay. A tool that appends, increments,
sends, or charges without a receipt is not replay-safe and must not claim it.

### DP-104 Persisted names are contracts · blocker

Doc kinds, versions, scopes, fork behavior, tool names, job ids, phase ids, table and column names,
HTTP paths, and query parameters are persisted or client-visible. Renaming one needs a migration
and a version bump. `ai_docs/durable_pi/maintainability-audit.md` lists the current set to preserve.

### DP-105 Commit state and receipt together · blocker

Mutate a document and write its receipt inside one `commit`/`tx.doc` block. Two commits expose a
window where the effect happened but the receipt did not, or the reverse. The todo tool in
`dpi-backend/src/extensions.ts` is the reference shape.

## TS: tests

### TS-501 Test behavior through the public surface · minor

Call the HTTP API, the client, or the tool definition, and assert observable results. A test that
reaches into private fields breaks on refactors that preserve behavior; a test that mirrors the
implementation proves nothing. Tool definitions that close over nothing can be driven directly.

### TS-502 Make tests deterministic · major

Use the faux model, temp directories, and the `until()` polling helper. No real network, no
`sleep(500)` guesses, no dependence on wall-clock ordering or test execution order. A flaky test
costs more than the bug it might catch.

### TS-503 Assert error codes and shapes, not prose · minor

Check `e.code === "busy"` and `status === 409`. Messages are UI text and change. Match prose only
when the text is the contract, as with model-facing tool output.

### TS-504 Cover the edges the architecture exists for · major

Where the diff touches durable state, cover replay after a crash, abort mid-run, restart or reopen,
and two writers. Where it touches a stream, cover disconnect and reconnect. Where it touches a
tool, cover invalid arguments. These are the failures the durable design is for.

### TS-505 Assert fixtures instead of using `!` · minor

Find a fixture entry with an `assert` or a guard, then use the narrowed value. `!` on a lookup
turns a broken fixture into a confusing `TypeError` later in the test. Reserve `!` for a value a
preceding branch has proven, as the TUI does with `this.handle` after a guard.

## TS: security and logging

### TS-601 Log at the edge, never with secrets · blocker

Services log with a component prefix (`[dpi-backend] ...`) at the process boundary; library code
returns errors instead of printing them. Extensions report through the caller or `ctx.ui`:
stdout belongs to the active interface, where the TUI draws and JSON and RPC modes reserve it for
protocol records, so a stray `console.log` corrupts the screen or the stream. Tokens,
authorization headers, API keys, document contents that may hold secrets, and full provider
payloads stay out of logs, errors, and telemetry.

### TS-602 Authenticate new endpoints by default · blocker

Every new route, SSE endpoint, or local server requires auth unless the diff argues otherwise, and
the exception is narrow: `/healthz` is the only open route in `dpi-backend`. A hub that injects a
token must not hand it to the browser. Check the bind address: loopback for local-only, all
interfaces only when intended.

### TS-603 Bound untrusted input · blocker

Limit body size, string length, array length, outbound fetch time, and JSON depth. Resolve paths
inside an allowed root before reading them. Validation without a bound still lets a 10 MB string
into a document or a directory walk escape its root.

## TS: structure and naming

### TS-701 Split by reason to change, around 300 lines · minor

A file past roughly 300 lines usually changes for more than one reason. Split by that reason: one
job per file with its metadata and handlers together, one tool family with its document, a store
facade that delegates. Do not split a single tool into its own file just to hit a number. When a
refactor plan sets a stricter ceiling for the files it covers, follow the plan under Rule
precedence.

### TS-702 Feature-first layout, stable prompt order · minor

Feature code imports the feature contract, the store interfaces it needs, and SDK types; it does
not import sibling features. Assembly stays in one place, or the install order becomes the
documented contract. Either choice works. What does not work is changing tool or section order by
accident, because order changes the prompt and the cache. A refactor that changes it needs an
updated contract snapshot and a note in the PR. The target layout is in
`ai_docs/durable_pi/maintainability-audit.md`.

### TS-703 Naming · nit

PascalCase types, camelCase values and methods, UPPER_SNAKE module-level tunables, `isX` guards,
booleans that read as assertions (`closed`, `applied`). No `I` prefix, no `Enum` suffix. Pi's event
names and wire fields keep their shipped spelling, including snake_case.

### TS-704 Comments give the reason · nit

A file header names the module's job when the path does not. Section banners (`// ---- device`) are
welcome. Comments explain what a reader cannot infer: why a bound exists, why a catch is empty, why
an order matters. Delete commented-out code and restatements of the signature.

### TS-705 No speculative abstraction · minor

No abstraction with one caller, config flag with one value, or interface with one implementation
added for later. Five features do not need a plugin framework; explicit arrays are easier to debug.
A second caller is the trigger for generalizing.

## Before you file a finding

Skip these, or the review reads as noise:

- Formatting, indentation, quotes, tabs versus spaces. Both tab and space styles are established in
  the ecosystem; follow the file.
- Missing explicit return types on local functions and private methods. `tsc` infers them, and the
  repo does not annotate them.
- `.js` versus `.ts` import specifiers when they match that package's `tsconfig`.
- `interface` versus `type` for a local shape. Both appear in the codebase; only TS-104's ownership
  rule matters.
- `as` assertions after a runtime validation, or inside test fixtures.
- `!` where a preceding branch proved the value.
- Empty `catch {}` in cleanup and retry loops that TS-302 allows.
- A tool description that sounds verbose. It is a prompt, and detail is the point.
- A missing `outputSchema` on a tool that only returns text.
- Suggesting zod where the ecosystem uses TypeBox.
- Pre-existing debt in `jobs.ts` or `extensions.ts` unless the diff makes it worse.
- A refactor from the maintainability audit that the diff does not touch.
- A rule ID repeated for the same root cause at several call sites. Report it once and list the
  sites.

## Changing these standards

Rule IDs are stable. Add new rules at the end of their category so existing citations stay valid.
Removing or renumbering an ID needs a note in the PR that changes this file.
