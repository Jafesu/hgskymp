# HardGaming Launcher

Electron launcher for SkyMP servers. Generic by design: it lists whatever
servers the configured backend knows about, and connects directly to any
address you give it, listed or not.

## Running

```bash
npm install
npm start          # or: npm run dev
HG_BACKEND_URL=http://127.0.0.1:8099 npm start   # point at a local backend
```

The backend URL is also editable in Settings, so a rebuild is never needed to
repoint it.

**If it exits with `Cannot read properties of undefined (reading 'whenReady')`,
check for `ELECTRON_RUN_AS_NODE` in the environment.** With that set, Electron
runs as plain Node and `require('electron')` returns a path string instead of
the API. Some editors and agent tools set it on their child processes.

## Discovery

Two independent sources, because they answer different questions and fail
separately:

- **the backend** knows which servers exist and holds their modpacks;
- **each server's own http port** answers `/api/status` whether or not it is
  listed anywhere.

Neither is a fallback for the other. The backend's view is only ever as fresh
as the last heartbeat, so a server that died seconds ago still reads online
there; the list therefore confirms every entry against the server itself before
drawing it. A server nobody listed is still joinable by address, with no
backend involved at all.

The http endpoints share the game port. That one is UDP and this is TCP, so one
address covers both and there is no second port to discover.

## Layout

| Path | What |
| --- | --- |
| `src/main.js` | Main process, window, IPC |
| `src/preload.js` | The only surface the renderer gets: no node, no fs |
| `src/lib/servers.js` | Discovery, status polling, modpack fetch |
| `src/renderer/` | UI |
| `test/backend.test.js` | Discovery tests against real listeners |

## Tests

```bash
npm test
```

Stands up a stub backend and two stub game servers, one deliberately dead, and
checks address parsing, liveness, modpack fetch, and that a stale backend entry
is corrected to offline.

## Not built yet

Play is disabled: installing a modpack needs the Nexus integration and the MO2
pipeline, which are the next steps. Everything up to and including reading a
server's modpack works.
