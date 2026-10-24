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
| Task `news.digest` | `src/digest.ts` | One phase, one commit, one outcome. Started by the tool, runs in the background, and records the last run in App State under `/news`. |
| Pack | `src/pack.ts` | One document, one extension, one capability (`news`). Default export for `DPI_PACK`; imports the device through its `pack-api.ts` only. |
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

`DPI_PROVIDER=faux` also works: the offline double is the device's (`apps/dpi-backend/src/faux.ts`), so every app on
the device can run without a key. The demo app replaces it with a scripted superset, because its scripts name its own
tools.

Or point an existing device image at it without a rebuild:

```bash
DPI_PACK=/opt/durable-pi/apps/dpi-news-backend/src/pack.ts dpi-backend
```

## What it deliberately does not have

- **No GUI.** The playground shell is the demo's; a news pane would be the first capability-gated component. Until
  then the TUI and `curl` are the clients.
- **No routes.** The device's `/v1` surface plus the docs route is enough for a client to read this app.
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
