# HardGaming SkyRP — Platform Plan

## Context

The previous repository was a fork built around one specific server (Alduinak).
Its launcher, backend and gamemode were all hard-wired to that deployment, so
it could not host anyone else's server without editing source. This repository
is a clean fork of upstream SkyMP, and the goal is a **generic platform**: any
operator can run a server, publish a modpack, and have players find and join it
through one launcher.

Four things have to exist for that:

1. a server that can be deployed anywhere (Docker / Pterodactyl),
2. a backend that knows which servers exist and what mods each requires,
3. a launcher that lists servers, installs the right modpack, and connects,
4. an admin path for assembling a modpack in the first place.

Everything below is new work except a small set of platform fixes carried over
from the old fork, which were verified working there.

---

## What carries over

Verified in the old repo; port as-is except where noted.

| Item | Why | Change needed |
| --- | --- | --- |
| `uiPort` setting in `skymp5-server/ts/ui.ts` | The http port derives as `port + 1` (or 3000), which no orchestrator handing out arbitrary allocations can guarantee is free | Port verbatim, plus the docs entries |
| `deploy/docker/` | Working Linux server image; boots and serves | De-brand paths and names |
| `deploy/pterodactyl/` | Two eggs, BYO and dev | De-brand, rename image |
| Linux CI checkout fix | `linux-build-base.yml:39` pins `repository: skyrim-multiplayer/skymp`, so the workflow builds **upstream, not this fork**. Same bug is present here | Remove the pin |
| `workflow_dispatch` + `paths` filter on `pr-linux-variants.yml` | Lets a branch be built without a PR; stops backend/launcher edits triggering hours of C++ | Port |
| Disable `trigger-installer.yml` | Fires at upstream's installer repo with a PAT we don't have; fails on every push | `gh workflow disable` |

**Does not carry over:** the `EspmFileTable` clang fix and the forbidden-reloot
test fix were both fork-only code that does not exist here.

The old repo stays on GitHub as reference. Worth cherry-picking later if
needed: `docs/alduinak_voice_chat.md` (LiveKit proximity voice design and its
trust-model caveats) and `docs/docs_roleplay_*.md` (client/server contracts for
property, factions, arrest/carry).

---

## 1. Backend (new, minimal)

New `skymp5-backend/`. Deliberately small — only what the platform needs, none
of the old fork's Discord/dashboard/whitelist baggage.

```
GET  /api/servers                 public server list + live status
GET  /api/servers/:id             one server's detail
POST /api/servers/register        game server heartbeat (auth: server key)
GET  /api/servers/:id/modlist     the modpack this server requires
PUT  /api/servers/:id/modlist     admin publishes a modpack (auth: admin key)
GET  /api/launcher/version        launcher update feed
```

**Modlist shape** — the contract everything else is built on:

```jsonc
{
  "version": 3,                  // bumped on every publish
  "updatedAt": "2026-08-13T...",
  "mods": [
    {
      "name": "SkyUI",
      "nexusModId": 12604,
      "nexusFileId": 749043,
      "fileName": "SkyUI-12604-6-11.zip",
      "sha256": "...",           // integrity, and lets the launcher skip re-downloads
      "size": 1234567,
      "plugins": ["SkyUI_SE.esp"] // contributed to the load order
    }
  ],
  "loadOrder": ["Skyrim.esm", "...", "SkyUI_SE.esp"],
  "serverPlugins": ["..."]        // subset the SERVER also loads
}
```

Two separate lists matter. `loadOrder` is what the client must reproduce
exactly. `serverPlugins` is the subset whose records the server simulates.
Cosmetic mods appear in `loadOrder` only, and must sort **after** every server
plugin.

Storage: flat JSON on disk to start (`data/servers/<id>.json`). No database
until there is a reason for one.

## 2. Game server changes

- **Register with the master.** Upstream already has
  `skymp5-server/ts/systems/masterClient.ts` doing periodic registration —
  reuse it rather than writing new code, extending the payload with the
  modlist version so the backend can tell when a server's pack changed.
- **Serve its own modlist.** The server already generates
  `data/manifest.json` via `skymp5-server/ts/manifestGen.ts` (filename, crc32,
  size per plugin, plus load order) and serves `dataDir` over the http port.
  The launcher can read this directly, which is the authoritative check anyway
  — the client compares against it at connect time.

**Do not invent a second source of truth.** `manifestGen.ts` already produces
what `loadOrderVerificationService.ts` validates against; the backend modlist
must be derived from it, not maintained in parallel.

## 3. Pterodactyl / Docker additions

On top of the ported container work, add env vars so a hosted server
participates in the platform:

| Variable | Purpose |
| --- | --- |
| `MASTER_URL` | backend to register with (already exists) |
| `MASTER_KEY` | server's registration secret (already exists) |
| `SERVER_PUBLIC_NAME` | name shown in the launcher list |
| `SERVER_DESCRIPTION` | blurb for the list entry |
| `MODLIST_URL` | optional: pull the modpack from the backend on boot |

The entrypoint gains a step that fetches `MODLIST_URL`, downloads the server
plugins into `data/`, and writes `loadOrder` into `server-settings.json` —
reusing the existing `render-settings.js` merge logic rather than a new path.

## 4. Launcher (new, HardGaming SkyRP)

New Electron app. **Written from scratch**, not a re-skin: new information
architecture, new visual design, new code. The mechanical parts that must
behave a certain way — MO2 profile layout, the `nxm://` protocol handshake,
Nexus API request shapes — are interface requirements, not copied work, and
will be implemented independently against those APIs.

### Screens

1. **Server list** — cards from `GET /api/servers` with name, players, ping,
   modpack size. Plus **direct connect** by `host:port` for unlisted servers.
2. **Install / play** — one button. Diffs the server's modlist against what is
   installed, shows what will be downloaded, then installs and launches.
3. **Mod browser (admin only)** — search Nexus, add mods, arrange load order,
   publish to a server via `PUT /api/servers/:id/modlist`.
4. **Settings** — game path, Nexus account, graphics, hotkeys.

### Nexus: two download paths, auto-detected

This is the sharpest constraint in the whole plan. **Verified against the live
API:** `/v1/games/skyrimspecialedition/mods/:id/files/:fid/download_link.json`
returns `403 "You don't have permission to get download links from the API
without visting nexusmods.com - this is for premium users only."`

So:

- **Premium** — resolve download links through the API and fetch every archive
  silently. Fully automatic.
- **Free** — `nxm://` handoff. The launcher registers itself as the `nxm:`
  protocol handler, opens each required mod's page in batches, the player
  clicks "Mod Manager Download", the browser hands the `nxm://` URL back, and
  the launcher downloads and installs it. One click per mod. This is how
  Vortex and MO2 handle free accounts.

Detect premium at login (`/v1/users/validate.json` returns `is_premium`) and
pick the path silently. Never dead-end a free user.

### Install pipeline

Archive → verify `sha256` → extract → place into an MO2 mod folder → write
`modlist.txt` and `plugins.txt` → verify the resulting plugin order against the
server manifest **before** launching, so a mismatch is caught in the launcher
rather than as a failed connection.

### Branding

`HardGaming SkyRP` throughout: product name, installer, icons, window title,
update feed. No `Alduinak` string anywhere.

---

## Sequencing

1. Port the platform fixes (uiPort, CI, Docker, eggs) and de-brand — small, unblocks hosting
2. Backend skeleton + modlist contract — everything else depends on this shape
3. Game server registration + modlist derivation from `manifestGen.ts`
4. Launcher: server list, direct connect, install/play
5. Launcher: Nexus login, both download paths
6. Launcher: admin mod browser and publish
7. Pterodactyl modlist env vars and entrypoint step

Steps 1–3 give a hostable server that appears in a list. Step 4 gives a
playable loop. 5–7 complete it.

---

## Verification

- **Server**: `docker build --target runtime-byo`, boot with real master files,
  confirm the readiness marker and that `uiPort` is honoured. The old fork's
  container passed exactly this.
- **CI**: `ctest` green on Linux with `UNIT_DATA_DIR` pointed at real masters.
  Confirm the checkout fix by checking the run builds *this* repo's SHA.
- **Backend**: register a server, fetch the list, publish a modlist, fetch it back.
- **Launcher, premium path**: log in with a premium key, install a two-mod pack
  into a clean MO2, confirm `plugins.txt` matches the server manifest.
- **Launcher, free path**: log in with a free key, confirm it falls back to
  `nxm://` and that a click-through completes an install.
- **End to end**: fresh machine, pick the server from the list, press Play,
  reach the character screen with no manual mod work.
