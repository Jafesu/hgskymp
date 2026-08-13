# HardGaming SkyMP server container

Linux container image for the game server. The Windows-side pieces (the
launcher, SkyrimPlatform, the client) are not part of this image and are not
containerised: the client is a Windows game mod.

## What needs a rebuild, and what does not

This is the important part for anyone running a server. Only the **engine**
lives in the image. Everything an operator touches lives in the volume.

| In the image, needs a rebuild | In the volume, file level |
| --- | --- |
| `scam_native.node`, the C++ engine | `server-settings.json`, all config |
| `dist_back/skymp5-server.js`, the server host | `gamemode.js` / `gamemode_extensions/`, all game logic |
| | `data/`, master files, mods, plugins, `scripts/*.pex` |
| | `world/`, saves and change forms |

So adding mods, editing settings, changing spawn points, writing quest logic
or dropping in Papyrus scripts is **upload and restart** — no rebuild. Gamemode
edits do not even need the restart: the server watches `gamemode.js` and
hot-reloads it within a second.

A rebuild is only needed when the engine itself changes: C++ under
`skymp5-server/cpp`, `libespm`, `papyrus-vm`, or the server's TypeScript host.
That is platform work, published once as a new image tag. On restart the
entrypoint re-links `scam_native.node` and `dist_back` into the volume, so the
upgrade lands without touching operator files.

## Game files

The server loads `Skyrim.esm`, `Update.esm`, `Dawnguard.esm`, `HearthFires.esm`
and `Dragonborn.esm` at startup. Those are Bethesda's copyrighted files. They
are not in the image and never will be: copy them out of your own install at

```
<Steam>/steamapps/common/Skyrim Special Edition/Data/
```

into the server's `data/` directory. The container refuses to start without
them and names the ones it cannot find.

`runtime-dev` downloads them from the mirror this repository's CI already uses.
That is a convenience for local testing, not a licence, and building it needs
an explicit acknowledgement:

```bash
docker build -f deploy/docker/Dockerfile --target runtime-dev \
  --build-arg I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE=yes \
  -t skymp-server:dev .
```

Without that build-arg the stage fails, so no CI job or stray `--target` can
produce a pushable image full of Bethesda's files.

## Building

Build from the repository root; the context is the repo, not this directory.

```bash
docker build -f deploy/docker/Dockerfile --target runtime-byo \
  -t ghcr.io/jafesu/skymp-server:byo .
```

The first build compiles every vcpkg dependency from source and takes roughly
45 minutes. BuildKit cache mounts carry the vcpkg binary cache between builds,
so later ones only recompile what changed. On a machine short on RAM per core,
cap the parallelism with `--build-arg BUILD_JOBS=4`.

Only the server is built: `-DBUILD_SKYRIM_PLATFORM=OFF` because SkyrimPlatform
is MSVC-gated, and no client, front or Papyrus scripts.

CI publishes `runtime-byo` to GHCR on pushes to `main` and on `server-v*` tags.
See [.github/workflows/docker-server.yml](../../.github/workflows/docker-server.yml).

**Check the package's visibility after the first publish.** A package under a
personal account with a public repo is normally created public, but an
org-owned one defaults to private. A private package cannot be pulled
anonymously, so Wings nodes would each need registry credentials.

## Layout

The image keeps its binaries in `/opt/skymp` and treats `/home/container` as
the server directory, because the server resolves everything relative to its
working directory: it requires `./scam_native.node`, reads
`./server-settings.json`, loads `./gamemode.js` and reads
`./dist_back/skymp5-server.js.map`.

| Path in the volume | What it is |
| --- | --- |
| `data/` | Master files, mods, `.bsa` archives, localisation |
| `data/scripts/` | Loose Papyrus the server executes. Must exist |
| `world/` | Persisted change forms, when `DATABASE_DRIVER=file` |
| `gamemode.js` | The live gamemode, hot-reloaded |
| `gamemode_extensions/` | Gamemode parts, concatenated into `gamemode.js` at boot |
| `server-settings.json` | Generated from the environment, then yours to edit |

## Configuration

`server-settings.json` is generated on first boot and merged on every later
boot. Keys whose environment variable is set are overwritten each time, because
on an orchestrator the allocation is authoritative; everything else you write
into the file is preserved.

| Variable | Setting | Notes |
| --- | --- | --- |
| `SERVER_PORT` | `port` | UDP. Pterodactyl sets this from the primary allocation |
| `UI_PORT` | `uiPort` | TCP. Static `data/`, `/metrics`, `/rpc` |
| `SERVER_NAME` | `name` | |
| `MAX_PLAYERS` | `maxPlayers` | |
| `OFFLINE_MODE` | `offlineMode` | `1` ignores the master API entirely |
| `MASTER_URL` | `master` | Backend to register with |
| `MASTER_KEY` | `masterKey` | Registration secret |
| `DATABASE_DRIVER` | `databaseDriver` | `file`, `mongodb` or `zip` |
| `DATABASE_NAME` | `databaseName` | |
| `DATABASE_URI` | `databaseUri` | MongoDB only |
| `DATA_DIR` | `dataDir` | Default `data` |
| `GAMEMODE_PATH` | `gamemodePath` | Default `gamemode.js` |
| `LISTEN_HOST` / `UI_LISTEN_HOST` | `listenHost` / `uiListenHost` | |
| `SERVER_LANG` | `lang` | |
| `LOAD_ORDER` | `loadOrder` | Comma or newline separated. Unset loads the five masters |
| `ARCHIVES` | `archives` | Comma or newline separated `.bsa` list |
| `START_POINTS_JSON` | `startPoints` | Raw JSON |
| `METRICS_AUTH_JSON` | `metricsAuth` | Raw JSON, `{"user":…,"password":…}` |

`UI_PORT` exists because the server used to derive its http port as `port + 1`
(or 3000 for the default 7777), which no orchestrator handing out arbitrary
allocations can guarantee is free.

### Getting listed in the launcher

Set these and the server registers itself with the platform backend and caches
its published modpack into `data/modpack.json`, which the http port serves.

| Variable | Purpose |
| --- | --- |
| `PLATFORM_URL` | Backend to register with. Blank leaves the server unlisted |
| `PLATFORM_SERVER_ID` | Stable id the server is listed under |
| `PLATFORM_REGISTRATION_KEY` | Bearer secret the backend requires |
| `PLATFORM_PUBLIC_HOST` | Address players connect to. **Required** with `PLATFORM_URL` |
| `PLATFORM_PUBLIC_PORT` | Only when it differs from the game port |
| `SERVER_DESCRIPTION` | One-line blurb for the list entry |

`PLATFORM_PUBLIC_HOST` is mandatory rather than inferred because the server
sees a bind address, not the NAT or DNS in front of it. Setting `PLATFORM_URL`
without it aborts the boot rather than listing an address nobody can reach.

The http port also serves an unauthenticated `/api/status` returning name,
players and maxPlayers, so a launcher can poll a server directly whether or not
it is listed.

## Gamemode

Two shapes are supported:

1. Upload `gamemode.js` directly, or
2. Drop parts into `gamemode_extensions/` and let the entrypoint concatenate
   them in filename order, with a syntax check and an atomic replace.

With neither, the entrypoint writes an empty `gamemode.js`. The server runs and
players connect and spawn, with no roleplay logic. A part with a syntax error
aborts the boot rather than silently running the previous gamemode, which would
look like a successful deploy of the broken one.
