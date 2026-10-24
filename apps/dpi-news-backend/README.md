# dpi-news-backend

The smallest complete app on the pack seam: pi-durable's device (`apps/dpi-backend`, unchanged) plus one
conversation document, one tool and one durable task. It exists to answer one question — what does a second
app actually cost? — and the answer is this directory.

## What it adds

| Piece | File | Notes |
|---|---|---|
| Document `news.stories` | `src/stories.ts` | Conversation-scoped, rewindable, forked as of the fork point. Holds the list, a run counter and the last digest. |
| Receipt `news.receipt` | `src/stories.ts` | Task-scoped, so a replayed tool call returns its first result. |
| Tool `news` | `src/tool.ts` | `add`, `list`, `rank`, `digest`. Every action commits its edit and its receipt together. |
| Task `news.digest` | `src/digest.ts` | One phase, one commit, one outcome. Started by the tool, runs in the background. |
| Pack | `src/pack.ts` | One document, one extension, one capability (`news`). Default export for `DPI_PACK`. |
| Wire types | `apps/dpi-sdk/src/news.ts` | Shared with clients, like the demo's `todos.ts`. |

Nothing in `apps/dpi-backend` changes. The device seeds the pack's document list, serves it at
`GET /v1/sessions/:s/agents/:a/docs/news.stories`, and installs the extension in every session.

## Run it

```bash
cd apps/dpi-news-backend
npm install --no-bin-links      # --no-bin-links only on a bind-mounted checkout that refuses symlinks
npm run check && npm test
DPI_PROVIDER=<a real provider> npm start
```

There is no `faux` model here on purpose: `faux` is the demo app's provider, and a bare device refuses it. The tests
borrow the demo's faux in `tests/helpers.ts` to create a session, which is the one place this app depends on the demo.

Or point an existing device image at it without a rebuild:

```bash
DPI_PACK=/opt/durable-pi/apps/dpi-news-backend/src/pack.ts dpi-backend
```

## What it deliberately does not have

- **No GUI.** The playground shell is the demo's; a news pane would be the first capability-gated component. Until
  then the TUI and `curl` are the clients.
- **No App State.** `SharedState` is demo-pack code, not device code, so a second pack cannot write the shared JSON
  without importing or copying the demo. The digest writes only its own document. If a second app needs it, move
  `shared-state.ts` into the device first.
- **No routes.** The device's `/v1` surface plus the docs route is enough for a client to read this app.
- **No model.** See above; the pack supplies `models()` only when it owns an offline one, as the demo does.

## Two seams worth promoting before app #3

1. `foldEvery` (the `checkpointWhen` policy) is written here and in the demo pack. It belongs next to `DevicePack` in
   `apps/dpi-backend/src/pack.ts`, so a pack gets it with the interface.
2. The offline `faux` model is the demo's, while the device is the thing that needs a test double. A third app would
   copy it a second time.
