# syntax=docker/dockerfile:1.7
#
# OrcaSlicer Web — runtime image.
#
# Contains the *unmodified upstream* OrcaSlicer release binary (extracted from the
# official AppImage, no GUI / no VNC / no Xvfb) plus Node 22 for the API layer.
# See AGPL-NOTICE.md for the licensing rationale of shipping the binary this way.
#
# Bump procedure: change ORCA_VERSION + ORCA_APPIMAGE_SHA256 together, rebuild, then
# run `docker compose run --rm help-check` and refresh test/golden/orca-slicer-help.txt
# if (and only if) the diff is understood. See README.md.

# ---------------------------------------------------------------------------
# Pinned versions. Hard constraint #2: the OrcaSlicer version is an explicit ARG.
# ---------------------------------------------------------------------------
ARG ORCA_VERSION=2.4.2
ARG ORCA_APPIMAGE_SHA256=d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd
ARG NODE_VERSION=22.22.2
ARG NODE_SHA256=88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a
# The official Linux AppImage is built against Ubuntu 24.04; matching the base
# distro is what keeps the shared-library set small and the glibc ABI compatible.
ARG UBUNTU_TAG=24.04

# ---------------------------------------------------------------------------
# base — shared by every stage. Only exists so an operator behind a TLS-inspecting
# corporate proxy can drop PEM files into docker/extra-ca-certificates/ and have
# the download stages work. Empty (and a no-op) by default.
# ---------------------------------------------------------------------------
FROM ubuntu:${UBUNTU_TAG} AS base
ENV DEBIAN_FRONTEND=noninteractive
COPY docker/extra-ca-certificates/ /usr/local/share/ca-certificates/extra/
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# orca — download the pinned AppImage, verify it, extract it.
#
# `--appimage-extract` needs no FUSE and no privileged mount, which is why we use
# it instead of running the AppImage directly.
# ---------------------------------------------------------------------------
FROM base AS orca
ARG ORCA_VERSION
ARG ORCA_APPIMAGE_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN set -eux; \
    asset="OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage"; \
    url="https://github.com/SoftFever/OrcaSlicer/releases/download/v${ORCA_VERSION}/${asset}"; \
    echo "fetching ${url}"; \
    curl -fSL --retry 3 --retry-delay 5 -o orca.AppImage "$url"; \
    echo "${ORCA_APPIMAGE_SHA256}  orca.AppImage" | sha256sum -c -; \
    chmod +x orca.AppImage; \
    ./orca.AppImage --appimage-extract > /dev/null; \
    rm -f orca.AppImage; \
    mv squashfs-root /opt/orcaslicer

# Drop resources that only the desktop GUI ever reads. Keeps ~140 MB out of the
# final image. `resources/profiles` (needed by us and by the M2 catalog extractor),
# `resources/shaders`, `resources/printers`, `resources/fonts` and the small config
# resources are deliberately kept.
RUN set -eux; \
    cd /opt/orcaslicer; \
    rm -rf resources/hms resources/web resources/images resources/i18n \
           resources/handy_models resources/dailytip resources/Icon.icns \
           OrcaSlicer.png share; \
    du -sh /opt/orcaslicer

# ---------------------------------------------------------------------------
# node — official Node.js binary distribution, pinned and checksum-verified.
# (Ubuntu 24.04 only ships Node 18; NodeSource would add an apt repo we would then
# have to trust at every rebuild.)
# ---------------------------------------------------------------------------
FROM base AS node
ARG NODE_VERSION
ARG NODE_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    cd /tmp; \
    curl -fSL --retry 3 --retry-delay 5 -O "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt/node --strip-components=1 --no-same-owner; \
    rm -rf "node-v${NODE_VERSION}-linux-x64.tar.xz" /opt/node/share /opt/node/lib/node_modules/npm/docs

# ---------------------------------------------------------------------------
# build — compile every TypeScript workspace in the root solution.
#
# `tools/extractors` is built here too, because the `generate` stage below runs it. That
# is a deliberate change from M0/M1, where only `apps/api` was compiled to keep
# build-time tooling from breaking the runtime image: the image now *needs* the
# extractors' output, so a broken extractor should fail the build rather than produce an
# image that slices silently wrong (see the `generate` stage).
#
# `apps/web` is not in the root solution (Vite uses bundler resolution and DOM libs), so
# it is built separately by its own toolchain in the second RUN below — after the
# solution, because it imports `@orca-web/shared` through the workspace symlink and needs
# that package's `dist/` to exist. Its `build` script typechecks before it bundles, so a
# type error in the client fails the image build too.
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=node /opt/node /opt/node
ENV PATH=/opt/node/bin:$PATH \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    # Node has its own CA bundle, so the extra certificates installed in `base` are
    # invisible to npm without this. Harmless when the directory is empty.
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund
RUN npx tsc --build tsconfig.json
RUN npm run build -w @orca-web/web

# ---------------------------------------------------------------------------
# generate — run the M2 extractors, baking their artefacts into the image.
#
# WHY AT BUILD TIME: the running container then needs no network and no start-up work
# beyond one 26 MB `JSON.parse`. It also makes the artefacts and the binary provably the
# same OrcaSlicer release — both are keyed on ARG ORCA_VERSION.
#
# Two inputs, from two places:
#
#   * `resources/profiles` comes from the pinned AppImage that the `orca` stage already
#     extracted. Nothing is downloaded for it.
#   * `src/libslic3r/PrintConfig.cpp` and three sibling headers are fetched from
#     raw.githubusercontent.com at the pinned tag and verified against the SHA-256 pins
#     in `tools/extractors/src/upstream/sources.ts`. A checksum mismatch is a hard
#     failure — never a silent fallback to a mirror. (GitHub's tarball/codeload
#     endpoints are 403 under some egress policies; raw.githubusercontent.com is the
#     canonical origin and the only one this build needs.)
#
# The extractor exits non-zero if any option upstream defines was not extracted, or if
# any preset's `inherits` chain failed to resolve — which is exactly the condition that
# would make the CLI slice silently wrong (SPEC "VERIFIED CLI deviations" #1).
# ---------------------------------------------------------------------------
FROM build AS generate
ARG ORCA_VERSION
COPY --from=orca /opt/orcaslicer/resources /opt/orcaslicer/resources
ENV ORCA_VERSION=${ORCA_VERSION} \
    ORCA_RESOURCES=/opt/orcaslicer/resources \
    ORCA_GENERATED_DIR=/generated
RUN node tools/extractors/dist/cli.js \
 && rm -rf /generated/upstream \
 && du -sh /generated /generated/${ORCA_VERSION}/*

# ---------------------------------------------------------------------------
# prune — the same tree, reduced to runtime dependencies. Workspace symlinks survive,
# so the layout copied into the runtime stage must keep the same relative shape.
# ---------------------------------------------------------------------------
FROM build AS prune
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ARG ORCA_VERSION
LABEL org.opencontainers.image.title="orcaslicer-web" \
      org.opencontainers.image.description="Server-side OrcaSlicer CLI + Node API" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      com.orcaslicer-web.orca-version="${ORCA_VERSION}"

# Runtime shared libraries.
#
# This list was NOT guessed. It was derived by extracting the AppImage on a bare
# ubuntu:24.04 and iterating on `ldd /opt/orcaslicer/bin/orca-slicer | grep "not found"`
# until the list was empty. The 37 unresolved sonames map onto the packages below.
# The binary is a GUI build, so it links GTK3/WebKitGTK/GStreamer/OpenGL even
# though `--slice` never opens a window; those libraries must be present for the
# dynamic loader, and the AppImage's own launcher (libexec/orca-slicer-env) also
# hard-refuses to start without libOpenGL.so.0 and libwebkit2gtk-4.1.so.0.
#
#   libgtk-3-0t64                    -> libgtk-3, libgdk-3, libatk, libcairo(-gobject),
#                                       libpango*, libgdk_pixbuf, libglib/gio/gobject
#   libwebkit2gtk-4.1-0              -> libwebkit2gtk-4.1, libjavascriptcoregtk-4.1, libsoup-3.0
#   libgstreamer1.0-0                -> libgstreamer-1.0, libgstbase-1.0
#   libgstreamer-plugins-base1.0-0   -> libgstvideo-1.0
#   libsecret-1-0                    -> libsecret-1
#   libgl1 libglx0 libopengl0 libegl1 -> libGL, libGLX, libOpenGL, libEGL  (libglvnd)
#   libglu1-mesa                     -> libGLU
#   libsm6 libice6                   -> libSM, libICE
#   libx11-6 libxext6                -> libX11, libXext
#   libwayland-client0/-egl1/-server0 -> libwayland-*
#   libxkbcommon0                    -> libxkbcommon
#   libdbus-1-3                      -> libdbus-1
#   libfontconfig1 libharfbuzz0b     -> libfontconfig, libharfbuzz
#
# libexpat.so.1, libz.so.1, liblzma.so.5 and libmspack.so.0 are NOT installed:
# the AppImage bundles its own copies in lib/orca-runtime and its launcher puts
# that directory on LD_LIBRARY_PATH.
#
# `unzip` is used by the smoke test to read the .gcode.3mf archive.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgtk-3-0t64 \
      libwebkit2gtk-4.1-0 \
      libgstreamer1.0-0 \
      libgstreamer-plugins-base1.0-0 \
      libsecret-1-0 \
      libgl1 \
      libglx0 \
      libopengl0 \
      libegl1 \
      libglu1-mesa \
      libsm6 \
      libice6 \
      libx11-6 \
      libxext6 \
      libwayland-client0 \
      libwayland-egl1 \
      libwayland-server0 \
      libxkbcommon0 \
      libdbus-1-3 \
      libfontconfig1 \
      libharfbuzz0b \
      unzip \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /opt/node /opt/node
COPY --from=orca /opt/orcaslicer /opt/orcaslicer

# Expose the slicer on PATH under a stable name. We go through the AppImage's own
# AppRun so that upstream's environment setup (LC_ALL=C segfault workaround,
# LD_LIBRARY_PATH for the bundled lib/orca-runtime) stays authoritative — one less
# thing to re-derive on every version bump.
RUN set -eux; \
    printf '#!/bin/sh\nexec /opt/orcaslicer/AppRun "$@"\n' > /usr/local/bin/orca-slicer; \
    chmod +x /usr/local/bin/orca-slicer; \
    ln -sf /opt/node/bin/node /usr/local/bin/node; \
    ln -sf /opt/node/bin/npm /usr/local/bin/npm; \
    ln -sf /opt/node/bin/npx /usr/local/bin/npx

ENV ORCA_VERSION=${ORCA_VERSION} \
    ORCA_RESOURCES=/opt/orcaslicer/resources \
    # Where the M2 extractors wrote the config schema and the profile catalog at image
    # build time. `@orca-web/catalog` reads them from here; nothing regenerates at runtime.
    ORCA_GENERATED_DIR=/generated \
    PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    HOME=/home/orca \
    XDG_RUNTIME_DIR=/tmp/xdg-orca \
    XDG_CACHE_HOME=/home/orca/.cache \
    WORK_DIR=/work \
    DATA_DIR=/data \
    PORT=8080

# Hard constraint #4: every slice runs in a disposable sandbox under /work. /data is the
# opposite: the content-addressed model library, job metadata and published artefacts,
# all of which must survive a restart.
RUN set -eux; \
    useradd --create-home --home-dir /home/orca --uid 10001 --shell /usr/sbin/nologin orca; \
    mkdir -p /work /data /app /tmp/xdg-orca; \
    chown orca:orca /work /data /app /tmp/xdg-orca; \
    chmod 700 /tmp/xdg-orca

WORKDIR /app
COPY --chown=orca:orca scripts/ /app/scripts/
COPY --chown=orca:orca test/ /app/test/

# The compiled API. `node_modules` keeps its workspace symlinks, so the relative layout
# (/app/node_modules, /app/apps/api, /app/packages/*) must match the build stage.
# `tools/extractors` is deliberately NOT copied: it is build-time only, and
# docs/REPO-LAYOUT.md forbids the request path from importing it. Its *output* is.
COPY --from=prune --chown=orca:orca /src/node_modules /app/node_modules
COPY --from=build --chown=orca:orca /src/package.json /app/package.json
COPY --from=build --chown=orca:orca /src/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build --chown=orca:orca /src/packages/shared/dist /app/packages/shared/dist
COPY --from=build --chown=orca:orca /src/packages/catalog/package.json /app/packages/catalog/package.json
COPY --from=build --chown=orca:orca /src/packages/catalog/dist /app/packages/catalog/dist
COPY --from=build --chown=orca:orca /src/apps/api/package.json /app/apps/api/package.json
COPY --from=build --chown=orca:orca /src/apps/api/dist /app/apps/api/dist

# The web client (M3), as static assets. There is no second web server in this stack:
# `apps/api/src/http/static.ts` resolves this path relative to its own compiled location
# (`/app/apps/api/dist/http` → `/app/apps/web/dist`), so this destination is load-bearing.
COPY --from=build --chown=orca:orca /src/apps/web/dist /app/apps/web/dist

# The generated config schema and profile catalog (M2), keyed on ORCA_VERSION.
COPY --from=generate --chown=orca:orca /generated /generated

USER orca
EXPOSE 8080

CMD ["node", "/app/apps/api/dist/index.js"]
