# HardGaming SkyMP game server container.
#
# Build targets:
#   runtime-byo  production. Bring your own Skyrim .esm files.
#   runtime-dev  development ONLY. Bakes Bethesda .esm files into the image.
#                Never push this target to a registry. See README.md.
#
# Build from the repository root, not from this directory:
#   docker build -f deploy/docker/Dockerfile --target runtime-byo -t skymp-server .

# ─────────────────────────────────────────────────────────────────────────────
# Toolchain. Mirrors misc/deps_linux/ubuntu-2404.sh, pinned to clang-20.
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS build-base

ENV DEBIAN_FRONTEND=noninteractive TZ=Etc/GMT

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      clang-20 \
      ninja-build \
      nodejs \
      git \
      zip \
      unzip \
      tar \
      pkgconf \
      linux-libc-dev \
      automake \
      libtool \
      autoconf \
      autoconf-archive \
      bison \
      flex \
      libicu-dev \
 && npm install -g yarn \
 && ln -sf /usr/bin/clang-20 /usr/bin/clang \
 && ln -sf /usr/bin/clang++-20 /usr/bin/clang++ \
 && ln -sf /usr/bin/clang-cpp-20 /usr/bin/clang-cpp \
 && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────────────────────
# vcpkg checkout. Its own layer because the clone is large and rarely moves.
# The .dockerignore excludes vcpkg/, so the later COPY does not clobber it.
# ─────────────────────────────────────────────────────────────────────────────
FROM build-base AS deps

ARG VCPKG_URL=https://github.com/microsoft/vcpkg.git
# Keep in sync with the vcpkg submodule pin: git submodule status
ARG VCPKG_COMMIT=cb2981c4e03d421fa03b9bb5044cd1986180e7e4

ENV VCPKG_DISABLE_METRICS=1

WORKDIR /src

RUN git clone "$VCPKG_URL" vcpkg \
 && git -C vcpkg checkout "$VCPKG_COMMIT"

# ─────────────────────────────────────────────────────────────────────────────
# Build. Server only: SkyrimPlatform is MSVC-gated and the client is Windows.
#
# CMake resolves the vcpkg manifest during configure, so the packages cannot be
# built in a stage of their own. BuildKit cache mounts carry them between builds
# instead; the first build is slow, later ones reuse the binary cache.
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS builder

ARG BUILD_TYPE=RelWithDebInfo
# Cap parallelism on builders with little RAM per core
ARG BUILD_JOBS=0

COPY . /src

RUN chmod +x build.sh && sed -i 's/\r$//' build.sh

RUN --mount=type=cache,target=/root/.cache/vcpkg,sharing=locked \
    --mount=type=cache,target=/src/vcpkg/downloads,sharing=locked \
    if [ "${BUILD_JOBS}" != "0" ]; then export VCPKG_MAX_CONCURRENCY=${BUILD_JOBS}; fi \
 && ./build.sh --configure \
      -DCMAKE_BUILD_TYPE=${BUILD_TYPE} \
      -DBUILD_SKYRIM_PLATFORM=OFF \
      -DBUILD_CLIENT=OFF \
      -DBUILD_FRONT=OFF \
      -DBUILD_SCRIPTS=OFF \
      -DBUILD_UNIT_TESTS=OFF \
 && if [ "${BUILD_JOBS}" = "0" ]; then \
      ./build.sh --build --target skymp5-server; \
    else \
      ./build.sh --build --target skymp5-server -- -j${BUILD_JOBS}; \
    fi

# Fail early rather than shipping an image missing its addon
RUN test -f /src/build/dist/server/scam_native.node \
 && test -f /src/build/dist/server/dist_back/skymp5-server.js

# ─────────────────────────────────────────────────────────────────────────────
# Runtime. Pterodactyl conventions: user `container`, home /home/container.
#
# Only the engine lives in the image. Config, gamemode, mods and save data all
# live in the volume, so operators change them at file level and never rebuild.
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime-base

ENV DEBIAN_FRONTEND=noninteractive TZ=Etc/GMT

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      nodejs \
      tzdata \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -d /home/container -s /bin/bash container

# tini is not decoration. The server ends up as PID 1, and Linux does not apply
# default signal dispositions to PID 1, so a process without an explicit
# SIGTERM/SIGINT handler simply ignores them: a panel's stop button times out
# and escalates to SIGKILL, losing whatever was not yet flushed. tini takes
# PID 1 and forwards signals to a child that does die from them.

# scam_native.node links only libc, libm, libgcc_s, libresolv and libstdc++;
# vcpkg links the rest statically. Anything else nodejs needs arrives as its
# own apt dependency, so nothing further is pinned here.

COPY --from=builder /src/build/dist/server/scam_native.node /opt/skymp/scam_native.node
COPY --from=builder /src/build/dist/server/dist_back        /opt/skymp/dist_back

COPY deploy/docker/entrypoint.sh      /opt/skymp/entrypoint.sh
COPY deploy/docker/render-settings.js /opt/skymp/render-settings.js
COPY deploy/docker/build-gamemode.js  /opt/skymp/build-gamemode.js

# .gitattributes pins these to LF, but a build context can still arrive with
# CRLF (zip export, a checkout predating that rule). A CRLF shebang is fatal.
RUN sed -i 's/\r$//' /opt/skymp/entrypoint.sh \
                     /opt/skymp/render-settings.js \
                     /opt/skymp/build-gamemode.js \
 && chmod +x /opt/skymp/entrypoint.sh

# Deliberately no SERVER_PORT/UI_PORT/DATA_DIR defaults here. render-settings.js
# only overwrites a key when its variable is set, so baking defaults would make
# those settings permanently unmanageable from server-settings.json. Unset, the
# server and the entrypoint fall back to 7777, the derived ui port and ./data.
ENV SKYMP_HOME=/opt/skymp

USER container
WORKDIR /home/container

# One port, both protocols: the game is UDP and the http endpoints are TCP, so
# a single allocation covers both.
EXPOSE 7777/udp 7777/tcp

ENTRYPOINT ["/opt/skymp/entrypoint.sh"]
CMD ["node", "dist_back/skymp5-server.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Production image. The operator supplies the .esm files.
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime-base AS runtime-byo

LABEL org.opencontainers.image.title="SkyMP Server" \
      org.opencontainers.image.description="Multiplayer Skyrim roleplay server. Requires operator-supplied Skyrim Special Edition master files." \
      org.opencontainers.image.vendor="HardGaming" \
      org.opencontainers.image.url="https://hardgaming.tech/" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.source="https://github.com/Jafesu/hgskymp"

# ─────────────────────────────────────────────────────────────────────────────
# Development image. Bakes in Bethesda-copyrighted .esm files.
#
#   DO NOT PUBLISH. DO NOT DISTRIBUTE. LOCAL TESTING ONLY.
#
# These files are Bethesda's property. The mirror below is the one this repo's
# CI already uses for tests; it is not a licensed redistribution channel.
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime-base AS runtime-dev

USER root

ARG SE_DATA_BASE=https://gitlab.com/pospelov/se-data/-/raw/main

# Building this stage must be a deliberate act, so that no CI job or careless
# --target can produce a pushable image full of Bethesda's files by accident.
ARG I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE=no
RUN if [ "${I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE}" != "yes" ]; then \
      echo "runtime-dev bakes copyrighted game files into the image and must never be published." >&2; \
      echo "Rebuild with --build-arg I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE=yes if this is a local dev build." >&2; \
      exit 1; \
    fi

RUN mkdir -p /opt/skymp/dev-data \
 && for esm in Skyrim.esm Update.esm Dawnguard.esm HearthFires.esm Dragonborn.esm; do \
      echo "fetching $esm"; \
      curl -fsSL --retry 3 -o "/opt/skymp/dev-data/$esm" "${SE_DATA_BASE}/$esm"; \
    done \
 && chmod -R a+r /opt/skymp/dev-data

ENV SKYMP_DEV_DATA=/opt/skymp/dev-data

LABEL org.opencontainers.image.title="SkyMP Server (dev)" \
      org.opencontainers.image.description="DEVELOPMENT ONLY. Contains Bethesda-copyrighted game files. Do not distribute." \
      com.hardgaming.no-push="true"

USER container
WORKDIR /home/container
