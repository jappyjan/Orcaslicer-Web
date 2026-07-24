# OrcaSlicer Web

A self-hostable web app for slicing 3D models **from a phone**. Slicing happens on the
server, performed by the unmodified upstream **OrcaSlicer** binary driven through its
CLI. This repository builds the frontend, the API, the profile pipeline and the job
orchestration around it — it does not fork or patch OrcaSlicer.

Read [`docs/SPEC.md`](docs/SPEC.md) before contributing. It is the authoritative brief:
mission, hard constraints, non-goals, settled stack decisions, and a reference section on
how the OrcaSlicer CLI actually behaves.

**Status: M0 complete.** The container and the slicing smoke test exist. There is no HTTP
API and no UI yet — those are M1 and M3. See the milestone list in the spec.

Licensing: this project is AGPL-3.0-or-later and ships an unmodified AGPL OrcaSlicer
binary. See [`AGPL-NOTICE.md`](AGPL-NOTICE.md).

## What is in the image

|                |                                                                      |
| -------------- | -------------------------------------------------------------------- |
| OrcaSlicer     | **2.4.2**, official Linux AppImage, extracted (`--appimage-extract`) |
| Exposed as     | `orca-slicer` on `PATH`                                              |
| Node           | 22.22.2, official binary distribution                                |
| Base           | `ubuntu:24.04` — matches what upstream builds the AppImage against   |
| Display server | **none.** No GUI, no VNC, no Xvfb, no GPU.                           |

Thumbnail rendering (`Metadata/plate_N.png` inside the output archive) needs OpenGL and
therefore does not work headless — the file is simply absent. That is expected; the plan
is to render the preview client-side in WebGL and rewrite it into the archive before
serving. Nothing else about slicing requires a display.

## Quick start

Requires Docker with Compose v2+. Nothing else — no local Node needed for the smoke test.

```bash
docker compose build
docker compose run --rm smoke        # slice a bundled 20mm cube, assert the artefacts
docker compose run --rm help-check   # assert the CLI surface has not drifted
```

`smoke` is the M0 acceptance criterion. It slices `test/fixtures/cube20.stl` with stock
Bambu Lab X1 Carbon profiles and asserts that the `.gcode.3mf` exists and is a valid ZIP,
that the embedded G-code is real G-code, and that `Metadata/slice_info.config` carries a
filament figure and a time estimate. Expected output ends with:

```
SMOKE TEST PASSED
  model            cube20.stl
  printer          Bambu Lab X1 Carbon 0.4 nozzle
  process          0.20mm Standard @BBL X1C
  filament         Bambu PLA Basic @BBL X1C
  gcode lines      13907
  layers           100
  filament used    1.30 m / 3.94 g
  time estimate    980 s
```

Useful knobs: `SMOKE_MACHINE`, `SMOKE_PROCESS`, `SMOKE_FILAMENT`, `SMOKE_MODEL`, and
`KEEP_SANDBOX=1` to keep `/work/smoke.*` for inspection.

Drop into the image with the slicer on `PATH`:

```bash
docker compose run --rm shell
```

## Working on the code

```bash
npm install         # Node 22 required
npm run check       # format check + lint + typecheck + unit tests
npm test            # vitest, all workspaces
```

Layout and the reasoning behind it: [`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md).

## Bumping the OrcaSlicer version

The version is pinned in exactly one place and every check keys off it.

1. Pick the new **stable** release from
   https://github.com/SoftFever/OrcaSlicer/releases (skip alpha/beta/rc).

2. Get the checksum of the Linux AppImage asset:

   ```bash
   V=2.4.3
   curl -fSL -o /tmp/orca.AppImage \
     "https://github.com/SoftFever/OrcaSlicer/releases/download/v${V}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${V}.AppImage"
   sha256sum /tmp/orca.AppImage
   ```

   If upstream renames the asset, update the `asset=` line in the `orca` stage of the
   `Dockerfile` too.

3. Edit the `Dockerfile`: `ARG ORCA_VERSION` and `ARG ORCA_APPIMAGE_SHA256`.

4. Update `ORCA_VERSION` in `packages/shared/src/index.ts` and the version table in
   `AGPL-NOTICE.md`. `npm test` fails if these disagree with the `Dockerfile`.

5. Rebuild and re-check the runtime library set — a new upstream base distro can add
   sonames:

   ```bash
   docker compose build
   docker compose run --rm shell -lc 'ldd /opt/orcaslicer/bin/orca-slicer | grep "not found"'
   ```

   Anything printed here must be mapped to an Ubuntu package and added to the runtime
   stage of the `Dockerfile`, next to the existing annotated list.

6. Re-run the checks:

   ```bash
   docker compose run --rm help-check   # will fail — the version is on line 1
   docker compose run --rm smoke
   ```

7. Read the `help-check` diff line by line. This is the point of the golden file:
   OrcaSlicer changes its CLI surface between releases without mentioning it in the
   release notes. Once you understand every change and have adjusted any caller:

   ```bash
   docker compose run --rm --user "$(id -u):$(id -g)" help-check --update
   ```

8. Regenerate anything derived from the pinned version (from M2 onward: the config
   schema and the profile catalog).

Commit the `Dockerfile`, `packages/shared/src/index.ts`, `AGPL-NOTICE.md` and the
refreshed golden together, so the pin is always self-consistent.

## Building behind a TLS-inspecting proxy

If your network intercepts TLS, the image build cannot fetch the AppImage or the Node
tarball. Drop the interception CA (PEM, `.crt` extension) into
`docker/extra-ca-certificates/` and rebuild; the Dockerfile installs anything found
there. The directory is empty and the step is a no-op otherwise, and `*.crt`/`*.pem`
inside it are gitignored.
