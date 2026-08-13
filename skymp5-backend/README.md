# Backend

Server registry, modlist hosting and the launcher update feed. Deliberately
small: flat JSON on disk, one dependency, no database until there is a reason
for one.

## Running

```bash
npm install
REGISTRATION_KEY=... ADMIN_KEY=... npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `./data` | Where server records are written |
| `REGISTRATION_KEY` | *(unset)* | Secret a game server presents to register |
| `ADMIN_KEY` | *(unset)* | Secret for publishing modlists |
| `OFFLINE_AFTER_MS` | `90000` | Heartbeat age after which a server reads offline |
| `LAUNCHER_VERSION` | `0.0.0` | Version served to the launcher |
| `LAUNCHER_DOWNLOAD_URL` | *(unset)* | Where the launcher installer lives |

**An unset key disables that capability rather than opening it.** A
misconfigured deployment returns 503 instead of silently accepting anonymous
writes.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | Liveness |
| `GET` | `/api/launcher/version` | — | Launcher update feed |
| `GET` | `/api/servers` | — | Public server list, online first |
| `GET` | `/api/servers/:id` | — | One server |
| `POST` | `/api/servers/register` | registration | Game server heartbeat |
| `GET` | `/api/servers/:id/modlist` | — | The modpack a server requires |
| `PUT` | `/api/servers/:id/modlist` | admin | Publish a modpack |

Registration creates the record on first call and refreshes liveness after
that. It never touches the modlist: publishing is a separate action behind a
separate key.

## The modlist contract

```jsonc
{
  "version": 3,                    // assigned by the backend, bumped per publish
  "updatedAt": "2026-08-13T...",
  "mods": [
    {
      "name": "SkyUI",
      "nexusModId": 12604,         // optional, but both ids or neither
      "nexusFileId": 749043,
      "fileName": "SkyUI.zip",
      "sha256": "…64 hex chars…",  // integrity, and lets the launcher skip re-downloads
      "size": 1234567,
      "plugins": ["SkyUI_SE.esp"]  // [] for an asset-only mod
    }
  ],
  "loadOrder": ["Skyrim.esm", "SkyUI_SE.esp", "PrettyTrees.esp"],
  "serverPlugins": ["Skyrim.esm", "SkyUI_SE.esp"]
}
```

### Why publishing is strict

The client checks a server at connect time by comparing the player's plugin
list against the server's manifest **index by index from zero**, on filename,
crc32 and size. Three rules follow, and all three are enforced on `PUT`:

1. **`serverPlugins` must be a prefix of `loadOrder`.** Every client-only mod
   has to sort after all server plugins, or the indices diverge and nobody can
   connect.
2. **No archives anywhere in the order.** The client enumerates plugins only,
   so one stray `.bsa` shifts every index after it.
3. **Every plugin a mod provides must appear in `loadOrder`**, or the launcher
   installs something the server never expects.

Rejecting these at publish time turns a mystifying connect failure into a clear
error with the offending entry named. A rejected publish leaves the previous
modlist untouched.

## Tests

```bash
node test/smoke.js
```

Starts a real listener against a temporary data directory and covers auth,
input validation, the three modlist rules, version bumping, and that a rejected
publish does not clobber a good one.
