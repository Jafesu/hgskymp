# Pterodactyl eggs

Two eggs, both running the same published image
(`ghcr.io/jafesu/skymp-server`). They differ only in what the
install step puts into the volume.

| Egg | Install step | Use for |
| --- | --- | --- |
| `egg-skymp-server.json` | Creates the directory layout and tells the operator to upload their own master files | Anything real |
| `egg-skymp-server-dev.json` | Downloads the master files from the mirror this repo's CI uses | Internal testing only |

The dev egg fetches Bethesda's copyrighted files. It exists so a test server can
be brought up without hand-uploading five large files, and it must not be used
on a public or commercial node.

## Importing

Admin panel → Nests → Import Egg → upload the JSON. Then create a server on that
egg.

## One allocation

The server binds two things on the **same port number**:

- **UDP** for game traffic (RakNet)
- **TCP** for the http endpoints: static `data/` contents, `/api/status`,
  `/metrics` and `/rpc`

Different protocols, so they do not collide, and Pterodactyl maps both for a
single allocation. The container defaults the http port to whatever
`SERVER_PORT` it was given, so **the primary allocation is all you need and
there is nothing to configure**.

There is no `UI_PORT` egg variable on purpose. It existed briefly, defaulted to
3000, and that default was accepted unread: the server then bound a port Wings
had never routed, so it looked healthy while `/api/status` and the modpack were
unreachable from outside. A value that can be silently wrong is worse than no
value at all.

`uiPort` still exists as a setting for hosts that choose their own ports, and
setting `UI_PORT` in the environment still overrides the default if you ever
need them split.

## Game files

The production egg deliberately does not fetch them. After installing, upload

```
Skyrim.esm  Update.esm  Dawnguard.esm  HearthFires.esm  Dragonborn.esm
```

from your own `<Steam>/steamapps/common/Skyrim Special Edition/Data/` into the
server's `data/` directory over SFTP or the panel file manager. The server
refuses to start until all five are present and names the ones it cannot find.

## Gamemode

Upload `gamemode.js` into the server root, or drop parts into
`gamemode_extensions/` and let the container concatenate them in filename order
on each start. With neither, the server runs bare: players connect and spawn,
and no roleplay logic applies.

## Startup detection

The egg marks the server as started on `Current process ID is`, which the server
prints once the master files are parsed and the game socket is listening. World
load takes a while on first start; that is normal and the panel will sit in
"starting" until it passes.

Stop is `^C` (SIGINT).

## Registry access

The image is published to GHCR from
[.github/workflows/docker-server.yml](../../.github/workflows/docker-server.yml).
If the package is private, each Wings node needs registry credentials in its
`config.yml` under `docker.registries`. Making the package public avoids that,
and is safe: the image carries no game files.
