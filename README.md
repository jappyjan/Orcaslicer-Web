# OrcaSlicer Web

A self-hostable web app for slicing 3D models **from a phone**. Slicing happens on the
server, performed by the unmodified upstream **OrcaSlicer** binary driven through its
CLI. This repository builds the frontend, the API, the profile pipeline and the job
orchestration around it — it does not fork or patch OrcaSlicer.

Read [`docs/SPEC.md`](docs/SPEC.md) before contributing. It is the authoritative brief:
mission, hard constraints, non-goals, settled stack decisions, and a reference section on
how the OrcaSlicer CLI actually behaves.

**Status: M3 complete.** There is a usable web app: open `http://localhost:8080` on a
phone, upload an STL or 3MF, pick printer → nozzle → quality → filament from the 384-model
catalog, slice with live progress, read time/grams/metres/layers and download both the
`.gcode.3mf` project and the raw `.gcode`. Underneath it: `POST /jobs` with SSE progress,
artefact downloads, cancellation, a concurrency-limited queue and guaranteed sandbox
cleanup, plus `GET /catalog` over a config schema and a fully resolved profile catalog
generated at image-build time. Every preset reaches the slicer flattened, which is the one
thing that makes its output trustworthy (see "VERIFIED CLI deviations" #1 in the spec).
No 3D view yet — the plater is M4 and the G-code preview is M5.

Licensing: this project is AGPL-3.0-or-later and ships an unmodified AGPL OrcaSlicer
binary. See [`AGPL-NOTICE.md`](AGPL-NOTICE.md).

## What is in the image

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| OrcaSlicer     | **2.4.2**, official Linux AppImage, extracted (`--appimage-extract`)   |
| Exposed as     | `orca-slicer` on `PATH`                                                |
| Node           | 22.22.2, official binary distribution                                  |
| Base           | `ubuntu:24.04` — matches what upstream builds the AppImage against     |
| Display server | **none.** No GUI, no VNC, no Xvfb, no GPU.                             |
| `/generated`   | config schema + profile catalog for 2.4.2, 26 MB, built into the image |

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
docker compose run --rm integration  # M1 acceptance: three concurrent real slices
docker compose up api                # the web app + API on http://localhost:8080
```

Open `http://localhost:8080` — or, from a phone on the same network, the host's LAN
address. That is the whole app: the image contains the built frontend and Fastify serves
it, so there is no second container and no web server to configure.

```bash
# M2 acceptance: every process preset valid for a Bambu Lab H2S with a 0.4 nozzle
curl -s 'http://localhost:8080/catalog/presets?type=process&model=Bambu%20Lab%20H2S&nozzle=0.4' \
  | jq -r '.[] | "\(.name)  \(.config | length) resolved keys"'
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

## The slice service (M1) and the catalog (M2)

`docker compose up api` starts it on `:8080`. Everything is JSON except the multipart
upload and the artefact downloads.

| Endpoint                        |                                                               |
| ------------------------------- | ------------------------------------------------------------- |
| `POST /jobs`                    | multipart: model files + a `descriptor` JSON field → `202`    |
| `GET /jobs/:id`                 | state, progress, warnings, stats, artefacts                   |
| `GET /jobs/:id/events`          | SSE: `state`, `progress`, `done`, `failed`                    |
| `GET /jobs/:id/artifacts/:name` | `result.gcode.3mf` and `plate_N.gcode`                        |
| `DELETE /jobs/:id`              | cancel and clean up → `204`                                   |
| `POST /models`                  | upload without slicing → content ids                          |
| `GET /catalog`                  | vendors → printer models → nozzle variants (`?schema=1`)      |
| `GET /catalog/presets`          | `?type=process\|filament&model=…&nozzle=…` → resolved presets |
| `GET /healthz`                  | engine and queue state, resolver, catalog counts              |

```bash
curl -X POST localhost:8080/jobs \
  -F 'descriptor={"printer":{"kind":"machine","vendor":"BBL","name":"Bambu Lab X1 Carbon 0.4 nozzle"},
                  "process":{"kind":"process","vendor":"BBL","name":"0.20mm Standard @BBL X1C"},
                  "filaments":[{"kind":"filament","vendor":"BBL","name":"Bambu PLA Basic @BBL X1C"}],
                  "input":{"kind":"models","models":[{"source":"upload","filename":"cube20.stl"}]}}' \
  -F 'files=@test/fixtures/cube20.stl'
```

The catalog is generated at image-build time and is static per OrcaSlicer version, so
both catalog routes carry an ETag and answer `If-None-Match` with a 304. `GET /catalog`
is 351 kB (708 kB with the schema) and deliberately omits the 11 551 preset bodies —
drill down with `/catalog/presets`. Presets come back **fully resolved**: the CLI ignores
`inherits` and fails silently if you do not do this for it.

Uploads are stored content-addressed and persist, so re-slicing at different settings
costs no upload: reuse the `models[].id` from the response with
`{"source":"library","id":"sha256:..."}`. The library is bounded by
`MODEL_LIBRARY_MAX_BYTES` with an LRU/TTL sweeper.

Two directories, with opposite lifetimes:

- **`/work`** — one disposable sandbox per job, `rm -rf`ed on success, failure, timeout
  and cancellation alike (hard constraint #4). It holds nothing between jobs.
- **`/data`** — the SQLite database, the model library and published artefacts. Mount a
  volume here.

Configuration is environment variables with defensible defaults; they are listed and
justified in [`apps/api/src/config.ts`](apps/api/src/config.ts). The ones worth knowing:
`SLICE_CONCURRENCY` (default: CPU count − 1; slicing is CPU-bound),
`SLICE_TIMEOUT_MS`, `QUEUE_DRIVER` (`memory` — the shipped default — or `bullmq`, which
is stubbed and throws), `MODEL_LIBRARY_MAX_BYTES`.

Design decisions behind the boundaries: [`docs/adr/`](docs/adr/).

## The web app (M3)

`apps/web` — React + Vite + Tailwind, built to static assets that the API serves from
`/app/apps/web/dist`. One image, one process, same origin, no CORS.

The whole flow is upload → printer → nozzle → quality → filament → slice → download, and
it is shaped by hard constraint #5: **mobile is the primary target, not a responsive
afterthought.** Concretely, and verified in Chromium at 390×844 with touch emulation:

- Every interactive element is at least 48 px tall (the `tap` utility). Nothing in the
  app responds to hover — a thumb cannot hover — and `apps/web/src/no-hover.test.ts`
  fails the build if a `hover:` style or a bare `<button>` without `tap` appears.
- Nothing overflows horizontally at 390 px. The one horizontally scrolling element (the
  filament material chips) scrolls inside its own container.
- **384 printer models** are a two-level drill-down — 64 brands by display name
  (`BBL` → `Bambulab`), then that brand's printers — with a search box that abandons the
  hierarchy and matches every model at once.
- **392 filament presets** (1.3 MB for a Bambu H2S 0.4, because `OrcaFilamentLibrary` is
  offered for every printer) are fetched once and filtered client-side, with the printer
  vendor's own `defaultMaterials` pinned to the top, material chips (PLA/PETG/TPU/…) and
  a search box. The resolved `config` of each preset is dropped immediately after
  parsing; only the four fields the picker renders are retained.
- The **progress UI never assumes a 0→100 ramp.** Measured on the pinned binary, a 20 mm
  cube emits _two_ progress frames, the first at 70 % (SPEC deviation #10). So the bar is
  indeterminate until a real number arrives, never goes backwards, and says "still
  working" after a six-second gap instead of looking frozen. Engine warnings are shown as
  they arrive and are kept on the results panel.
- A model is uploaded once, to `POST /models`, and every job — including "Slice again" —
  refers to it by its `sha256:` content id. Two slices of the same model cost exactly one
  upload.

```bash
# dev: Vite on :5173 proxying /jobs, /models, /catalog and /healthz to the container
docker compose up -d api
npm run dev -w @orca-web/web
```

## The touch plater (M4)

`apps/web/src/three` + `apps/web/src/state/plate.ts` — a three.js build plate you arrange
with a thumb, and the serialisation that makes the slice land where the screen said.

The whole screen is one line of the brief made literal: **transform via an explicit mode
toggle with sliders and numeric fields, not desktop-style drag gizmos.**

- **The finger in the 3D view only moves the camera.** One finger orbits, two pan and
  zoom, a tap selects. Nothing in the viewport is draggable — a drag handle on a phone is
  a small target underneath the very finger aiming at it. `OrbitControls` is deliberately
  not used: its two-finger gesture dollies and pans at once, so a pan always zooms a
  little. Here a pinch whose distance changed is a zoom and one whose midpoint moved is a
  pan, decided per move.
- **Move / Rotate / Scale are three full-width tabs**, each with a slider _and_ a number
  field. The slider is how a thumb says "a bit to the left"; the field is how it says
  120.0 mm — on a 256 mm bed at 390 px, one pixel is 0.7 mm, so a slider alone cannot hit
  a millimetre. Duplicate, delete, lay-flat, drop-to-bed, centre and ±90° are labelled
  full-width rows.
- **The plate is the printer's own.** `printable_area`, `printable_height` and
  `bed_exclude_area` come from the selected machine preset, fully resolved. Nothing is
  hardcoded — an X1C is 256 × 256 × 250 with a wipe pad in the front-left corner, and a
  plater that draws the wrong bed is worse than no plater because it looks right.
- **Off-the-plate and overlapping objects are shown before slicing**, in the colour of the
  object and in a line of text. The engine's answer to both is an exit code (`-52`, `-64`)
  a minute into a slice, which on mobile data is the difference between using this and not.
- **Auto-arrange delegates to the engine** (`--arrange 1`, `POST /plater/arrange`). There
  is no bin packer in this repo: the engine is the only thing that knows its own
  clearances and exclusion zones, and it gets the last word anyway.
- **Rotation and scale are baked into the geometry server-side.** The engine's plate
  description carries positions and nothing else, so a rotated object reaches the slicer
  as a re-exported binary STL with real facet normals (SPEC deviation #11).
- **The blank thumbnail is fixed.** The plate preview is rendered from the WebGL view,
  uploaded as a PNG and written into the `.gcode.3mf` — which, with `--min-save`, has no
  `Metadata/plate_1.png` member at all (deviation #5).

Acceptance, measured rather than eyeballed:

```bash
docker compose up -d api
node test/e2e/plater.mjs      # 390x844, touch emulation, a real slice
```

It places two objects with the on-screen controls (one of them turned 90°), slices, then
parses the extrusion coordinates out of the G-code and compares them with the numbers the
screen was showing. Both objects land within **0.000 mm** of their on-screen position at a
0.35 mm tolerance — the tolerance exists for the half-line-width inset of the outer wall,
not for placement error. It also asserts nothing overflows 390 px, every target is ≥ 44 px,
and `Metadata/plate_1.png` is present and non-blank in the served archive.

## Working on the code

```bash
npm install         # Node 22 required
npm run check       # format check + lint + typecheck (incl. apps/web) + unit tests
npm test            # vitest: the `unit` and `web` (jsdom) projects; no slicer binary
npm run test:integration   # the real-slice acceptance test, inside the container
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

8. The config schema and the profile catalog regenerate themselves — `docker compose
build` runs both extractors against the new binary's `resources/profiles` and the new
   tag's `PrintConfig.cpp`. You must refresh the SHA-256 pins in
   `tools/extractors/src/upstream/sources.ts` first, or the build fails on a checksum
   mismatch (deliberately — see `docs/PROFILE-PIPELINE.md`):

   ```bash
   npm run -w @orca-web/extractors extract -- --refresh-checksums
   ```

Commit the `Dockerfile`, `packages/shared/src/index.ts`, `AGPL-NOTICE.md` and the
refreshed golden together, so the pin is always self-consistent.

## Building behind a TLS-inspecting proxy

If your network intercepts TLS, the image build cannot fetch the AppImage, the Node
tarball, or the pinned OrcaSlicer C++ sources the config-schema extractor reads. Drop the interception CA (PEM, `.crt` extension) into
`docker/extra-ca-certificates/` and rebuild; the Dockerfile installs anything found
there. The directory is empty and the step is a no-op otherwise, and `*.crt`/`*.pem`
inside it are gitignored.
