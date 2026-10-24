# dpi-news-backend

The smallest complete app on the pack seam: pi-durable's device (`apps/dpi-backend`, unchanged) plus one
conversation document, one tool and two durable tasks. It exists to answer one question — what does a second
app actually cost? — and the answer is this directory.

## What it adds

| Piece | File | Notes |
|---|---|---|
| Document `news.stories` | `src/stories.ts` | Conversation-scoped, rewindable, forked as of the fork point. Holds the list, a run counter and the last digest. |
| Receipt `news.receipt` | `src/stories.ts` | Task-scoped, so a replayed tool call returns its first result. |
| Tool `news` | `src/tool.ts` | `add`, `list`, `rank`, `fetch`, `digest`. Every action commits its edit and its receipt together. |
| Task `news.digest` | `src/digest.ts` | One phase, one commit, one outcome. Started by the tool, runs in the background, and records the last run in App State under `/news`. |
| Task `news.fetch` | `src/fetch.ts` | Reads one feed per phase invocation and commits its progress, so a restart resumes at the next feed instead of the first. Adds what the list does not have and records what each feed did. |
| Feeds | `src/sources.ts` | `DEFAULT_SOURCES` plus `parseFeed`, a dependency-free RSS/Atom reader. |
| Task `news.triage` | `src/triage.ts` | Asks the device's classifier how relevant each unjudged story is to the list's `topics`, one story per invocation. Writes `relevance`, never deletes, and records why when it cannot judge. |
| Pack | `src/pack.ts` | One document, one extension, one capability (`news`). Default export for `DPI_PACK`; imports the device through its `pack-api.ts` only. |
| Wire types | `apps/dpi-sdk/src/packs/news.ts` | Shared with clients, like the demo's `packs/demo-todos.ts`. |

Nothing in `apps/dpi-backend` changes. The device seeds the pack's document list, serves it at
`GET /v1/sessions/:s/agents/:a/docs/news.stories`, and installs the extension in every session.

## Run it

```bash
cd apps/dpi-news-backend
npm install --no-bin-links      # --no-bin-links only on a bind-mounted checkout that refuses symlinks
npm run check && npm test
DPI_PROVIDER=<a real provider> npm start
```

`DPI_PROVIDER=faux` also works: the offline double is the device's (`apps/dpi-backend/src/faux.ts`), so every app on
the device can run without a key. The demo app replaces it with a scripted superset, because its scripts name its own
tools.

Or point an existing device image at it without a rebuild:

```bash
DPI_PACK=/opt/durable-pi/apps/dpi-news-backend/src/pack.ts dpi-backend
```

## Fetching the news

`news` with `action: "fetch"` starts a run. It reads the feeds in `DEFAULT_SOURCES` (Hacker News, Lobsters, The Verge),
keeps what this conversation's list does not already have, and writes `doc.fetch` — per-source `ok`/`added`/`skipped`,
plus an `error` for the ones that failed. It is on demand, not on a timer: a cron belongs outside the device, in an app
that calls `/v1` with the token.

## Judging relevance

`news` with `action: "topics"` says what the list is *for* ("durable execution, local-first sync"), and `action: "triage"`
starts a run that asks the device's classifier how much each unjudged story has to do with those topics. It writes
`relevance` (0-100) beside the story, plus `relevanceBy` naming the classifier that answered, and a `triage` record on the
document.

Four things about the shape:

- **Score, do not delete.** A dropped story is unrecoverable and un-auditable; a low score is a threshold you can move
  later. `relevance` (a judgement) is kept apart from `score` (a person's own ranking) so neither overwrites the other.
- **Topics first.** Without them there is nothing to be relevant to, so a run records `no topics on this list` and judges
  nothing rather than inventing a criterion.
- **Fail open, loudly.** No classifier, or a call that fails, is recorded in `doc.triage` with the stories left unjudged —
  never dropped, never defaulted to zero. Same rule the demo's `jev-damage-control` documents for itself.
- **One story per invocation, committed before the next call**, ≤20 per run, newest first. Judging costs a request; a
  restart must not pay for the same answer twice, and a run's cost should be bounded. Whatever a run does not reach is
  `deferred`, not lost.

The classifier is the device's: `createSession` hands every pack a `classify` function (pi-durable's `Models.classify`), so
Jev is reachable without this app depending on pi-ai or knowing which provider serves it. A pack may supply its own (a test
does) and it wins. Jev itself is `typesafe`'s `jev-latest` or `opencode`'s `jev-1.13` — `.env.example` notes that
`OPENCODE_API_KEY` serves it — and a device whose provider offers no classifier is a device where triage records an error
and everything else works.

**Feeds, not pages.** RSS and Atom are a site saying "here is a list you may read"; scraping an article page means
guessing at markup that changes and deciding for yourself what their terms allow. `parseFeed` handles those two formats
and nothing else — no namespaces, first match wins, and a feed it cannot read is reported as a failed source rather than
silently yielding nothing.

Two things a device has to allow for this to work:

1. **The hosts, in the sandbox's network policy.** `sbx/durable.yaml` lists the three defaults. A source you add needs
   its host added there (or to your local `sbx` policy), and a device behind an egress proxy whose Node is older than 24
   needs `NODE_USE_ENV_PROXY=1` for `fetch` to use it. A blocked request fails that one source with the status and the
   first line of the body — usually an explanation of the block — and the other feeds still land.
2. **A fetch run is capped** at 40 stories per run (and `limit` per source, ten by default), so a firehose cannot bury
   the list.

## What it deliberately does not have

- **No GUI.** The playground shell is the demo's; a news pane would be the first capability-gated component. Until
  then the TUI and `curl` are the clients.
- **No routes.** The device's `/v1` surface plus the docs route is enough for a client to read this app.
- **No job framework.** The demo's `JobRuns` document, phases and approval are its own; this app has two plain tasks
  instead, and their summaries live on the document they are about.
- **No App State tools of its own.** The device installs `read_state` and `update_state` on every device, so the agent
  here can read and change App State, including the `/news` key this app's digest writes.
- **No model of its own.** It uses the device's offline double, or the real provider you configure.

## What the device now provides, because this app needed it

1. `foldEvery` (the `checkpointWhen` policy) is exported from `apps/dpi-backend/src/pack.ts` beside `DevicePack`, so a
   pack gets the policy with the interface instead of writing its own.
2. App State is the device's store: `createSession` hands each pack `appState`, and the device serves
   `app.shared-state` whether or not a pack exists. A pack seeds only the keys it owns.
3. The offline `faux` model is the device's (`apps/dpi-backend/src/faux.ts`), so this app's tests no longer reach into
   the demo app for a provider.
