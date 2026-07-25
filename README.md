# OrcaSlicer Web

A self-hostable web app for slicing 3D models **from a phone**. Slicing happens on the
server, performed by the unmodified upstream **OrcaSlicer** binary driven through its
CLI. This repository builds the frontend, the API, the profile pipeline and the job
orchestration around it — it does not fork or patch OrcaSlicer.

Read [`docs/SPEC.md`](docs/SPEC.md) before contributing. It is the authoritative brief:
mission, hard constraints, non-goals, settled stack decisions, and a reference section on
how the OrcaSlicer CLI actually behaves.

**Status: M5 complete.** There is a usable web app: open `http://localhost:8080` on a
phone, upload an STL or 3MF, pick printer → nozzle → quality → filament from the 384-model
catalog, arrange the plate in a touch 3D view, slice with live progress, read
time/grams/metres/layers, **step through the resulting toolpath layer by layer**, and
download both the `.gcode.3mf` project and the raw `.gcode`. Underneath it: `POST /jobs`
with SSE progress, artefact downloads, cancellation, a concurrency-limited queue and
guaranteed sandbox cleanup, plus `GET /catalog` over a config schema and a fully resolved
profile catalog generated at image-build time. Every preset reaches the slicer flattened,
which is the one thing that makes its output trustworthy (see "VERIFIED CLI deviations" #1
in the spec).

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

| Endpoint                                |                                                               |
| --------------------------------------- | ------------------------------------------------------------- |
| `POST /jobs`                            | multipart: model files + a `descriptor` JSON field → `202`    |
| `GET /jobs/:id`                         | state, progress, warnings, stats, artefacts                   |
| `GET /jobs/:id/events`                  | SSE: `state`, `progress`, `done`, `failed`                    |
| `GET /jobs/:id/artifacts/:name`         | `result.gcode.3mf` and `plate_N.gcode`                        |
| `GET /jobs/:id/preview`                 | which plates have a G-code preview                            |
| `GET /jobs/:id/preview/:plate`          | the preview's layer index (JSON)                              |
| `GET /jobs/:id/preview/:plate/data`     | layer chunks, `Range`-addressable (M5)                        |
| `DELETE /jobs/:id`                      | cancel and clean up → `204`                                   |
| `POST /models`                          | upload without slicing → content ids                          |
| `GET /catalog`                          | vendors → printer models → nozzle variants (`?schema=1`)      |
| `GET /catalog/presets`                  | `?type=process\|filament&model=…&nozzle=…` → resolved presets |
| `GET /settings/resolved`                | preset values a slice would use, before overrides (M6)        |
| `GET/POST/PUT/DELETE /settings/presets` | named user presets — ours, not OrcaSlicer's                   |
| `GET /healthz`                          | engine and queue state, resolver, catalog counts              |

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

## The G-code preview (M5, server side)

G-code is never sent to the browser. `@orca-web/gcode` parses a plate's G-code **once**,
streaming, into a compact binary the client can load a layer at a time: fixed 18-byte
records carrying position, width, height, feature type and tool index, quantised onto a
grid spanning the toolpath, plus a JSON index of per-layer byte offsets.

```bash
curl -s localhost:8080/jobs/$ID/preview/1 | jq '.stats, .layers.offset[0:3]'
# then fetch just layers 120-139:
curl -s -H 'Range: bytes=1234-5678' localhost:8080/jobs/$ID/preview/1/data -o window.bin
```

Measured on a real 42 MiB G-code (a 90 mm box at 0.1 mm layers, 25 % infill): parsed in
**2.7 s** at **150 MB** peak RSS into **26 MiB** across **900 layers**, with a **23 KB**
index — so a twenty-layer window is about 600 KB rather than the whole model. The parse is
lazy, single-flighted, cached next to the job's artefacts and deleted with the job; both
endpoints are strongly ETagged and `immutable`.

Byte layout, quantisation, the index shape and the reasoning behind each choice:
[`docs/GCODE-PREVIEW-FORMAT.md`](docs/GCODE-PREVIEW-FORMAT.md). It also documents the
marker set OrcaSlicer 2.4.2 **actually** emits (`; FEATURE:`, `; CHANGE_LAYER`,
`; Z_HEIGHT:` — not the `;TYPE:` / `;LAYER_CHANGE` the spec assumed) and the arc and
leading-dot-`E` traps from verified deviation #4.

## The web app (M3)

`apps/web` — React + Vite + Tailwind, built to static assets that the API serves from
`/app/apps/web/dist`. One image, one process, same origin, no CORS.

### The workspace

The app is **one 3D viewport with everything else floating over it** — the arrangement
OrcaSlicer's desktop build and SimplyPrint's web slicer both use — plus a `Prepare` /
`Preview` switch between the plate and the toolpath. A labelled tool rail at the top left,
camera buttons at the bottom left, and a dock carrying the print, the objects and the
transform numbers.

It is not a desktop layout shrunk, and three things are why:

- **The dock is one column at every size.** Above 60 rem it is a card floating at the
  right; below it, the same column as a bottom sheet with three heights — peek, half,
  full — dragged or tapped by a 48 px handle. There is no second, mobile-only information
  architecture to keep in step, and the phone is the case that was designed first.
- **The free rectangle is measured and published.** Whatever the panels are not covering
  is exposed as `--free-*` custom properties and through `useViewportInsets()`. Overlays
  position against it and the scene offsets its projection into it (`setViewOffset` over a
  window the same size as the frame, so the frustum slides rather than narrowing and
  tap-to-select keeps landing where it looks like it does), and a camera fit frames to it
  rather than to the canvas. Without that, on a phone the plate would centre itself behind
  the sheet.
- **Nothing on the toolbar is an unlabelled icon.** The desktop original explains itself
  with tooltips and a tooltip needs a pointer, so every tool is a 48 px icon with its name
  printed underneath. Choosing Rotate on a phone also raises the sheet and scrolls the
  rotation fields into it — the tool and the numbers it opens are in different places, and
  the layout owns that seam rather than leaving it to the user.

A slice no longer takes the screen away: progress arrives in the dock while the plate
stays visible, and the finished toolpath is one tap away in the same viewport.

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

It is one line of the brief made literal: **transform via an explicit mode toggle with
sliders and numeric fields, not desktop-style drag gizmos.**

- **The finger in the 3D view only moves the camera.** One finger orbits, two pan and
  zoom, a tap selects. Nothing in the viewport is draggable — a drag handle on a phone is
  a small target underneath the very finger aiming at it. `OrbitControls` is deliberately
  not used: its two-finger gesture dollies and pans at once, so a pan always zooms a
  little. Here a pinch whose distance changed is a zoom and one whose midpoint moved is a
  pan, decided per move.
- **Move / Rotate / Scale are three tabs in the dock**, each with a slider _and_ a number
  field, and each also reachable from the floating rail. The slider is how a thumb says "a
  bit to the left"; the field is how it says 120.0 mm — on a 256 mm bed at 390 px, one
  pixel is 0.7 mm, so a slider alone cannot hit a millimetre. Duplicate, delete, lay-flat,
  drop-to-bed, centre and ±90° are labelled full-width rows.
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

## The G-code preview (M5, client side)

`apps/web/src/three/preview-*.ts` + `apps/web/src/state/preview.ts`. Switch to the
**Preview** tab on a finished job — or open `#preview=<jobId>` directly, which is what the
acceptance test does.

The budget is the design: **a 40 MB G-code file must open on a 4 GB phone without crashing
the tab**, and the layer slider must stay responsive while scrubbing.

- **A layer window, never the model.** Two sliders: which layer you are looking at — that
  one runs down the right-hand edge of the viewport, where the desktop build puts it — and
  how many layers below it to draw. A single "everything up to here" slider — what desktop
  slicers offer — holds the whole model by the time it reaches the top. The window is
  capped by _segments and bytes_, not by a layer count, because a layer of skirt and a
  layer of dense infill are nothing alike on either axis.
- **A window that shifts fetches only the difference.** Moving down one layer is one
  one-layer `Range` request, not a fresh twenty-layer download; layers that scroll out are
  disposed _before_ the next fetch, so the peak is one window and not two.
- **One `InstancedMesh` per layer** — one draw call each — sharing a unit-box geometry and
  one material. Colour is a per-instance attribute, so switching between colour-by-feature
  and colour-by-tool rewrites 12 bytes per segment and rebuilds nothing.
- **Nothing about the window is React state.** The controller lives outside the component
  tree; a scrub is sixty window changes a second and would otherwise be sixty renders.
  Building is time-sliced to 8 ms with a yield to `requestAnimationFrame`, and while a
  window is moving the scene draws at 10 Hz rather than 60 — nobody sees a picture that is
  replaced 16 ms later, and those frames belong to the gesture.
- **`extruder_offset` is added back.** G-code coordinates are plate coordinates _minus_ it
  (deviation #15); without the correction every toolpath sits 2 mm from the object it
  belongs to on a stock X1C. Applied once, as a translation on the group holding the
  toolpath.

## The generated settings UI (M6)

`apps/web/src/state/settings.ts` + `apps/web/src/ui/SettingsScreen.tsx`, over
`apps/api/src/settings/` and `apps/api/src/engine/orca/overrides.ts`.

Forms are rendered from M2's config schema — no option list is maintained by hand, so a
version bump regenerates the UI. **751 options, 100 % of what `PrintConfig.cpp` defines.**

**The information architecture, because 751 fields do not fit a 390 px column.** Four
tools, none of which is a tree:

- **Search** over label, raw config key, group and tooltip — the only workable path to the
  long tail. The key is printed under every field, so someone who knows `layer_height` need
  not guess what Orca calls it.
- **A disclosure level**, `simple ⊂ advanced ⊂ expert`, mirroring upstream's
  `ConfigOptionMode` (186 / 516 / 18 options). `develop` — upstream's hidden debug tier,
  31 options — is never rendered, at any level. A search that finds nothing because of the
  level says how many it is hiding and offers one tap to raise it.
- **Group drill-down**, one category at a time, full-screen with a Back row. The 11
  upstream `category` values come first; the 363 non-SLA options that have none (upstream
  only categorises the _print_ settings pages) are filed under the preset that supplies
  them — Printer / Filament / Process — which is read off the resolved presets, not
  guessed. The 76 SLA options and `extruder_printable_area` (`coPointsGroups`, the one
  option PROFILE-PIPELINE.md names as not generically renderable) are excluded.
- **"Show only what I changed"**, which deliberately ignores the disclosure level: an
  override you cannot see is how this screen would lie.

**"Modified" is measured against the preset, never against the compiled-in default.**
`GET /settings/resolved` returns the flattened machine ⊕ process ⊕ filament merge with a
per-key note of which preset supplied it. A key that is _absent_ is one the CLI would
silently fall back to its built-in value for, and the field says so in as many words —
that distinction is SPEC deviation #1 stated as a sentence on screen.

**Diff-and-override: only the changed keys travel, as CLI flags.** No profile file is
written, here or on the server; the settings priority puts a flag above `--load-settings`,
which is why one flag can change one key without disturbing the preset. Two measured
rules make the serialiser non-obvious, and both have regression tests:

- **One argv token per override, always `--key=value`** (SPEC deviations #23, #26).
  `--enable-arc-fitting 0` is _not_ a rejected value — it exits 253 with `No such file: 0`,
  because every boolean key is a switch and the `0` becomes a positional model path.
- **Vectors join with `,`, string vectors with `;`** (deviation #25). The wrong separator
  is silent for numbers: `--nozzle-temperature=235;240` keeps only `235`, at exit 0.

**Named user presets are ours.** A saved set is a _diff_ plus the catalog presets it was
captured against, stored in this application's SQLite file
(`GET/POST/PUT/DELETE /settings/presets`). Nothing is ever written into OrcaSlicer's
`resources/profiles` tree — the acceptance test snapshots that tree and asserts it is
byte-identical after a slice with overrides.

Acceptance, measured rather than eyeballed:

```bash
docker compose up -d api
node test/e2e/budget-job.mjs             # once: slices the real budget model, prints an id
node test/e2e/preview.mjs --job <id>     # 390x844, touch emulation, V8 capped at 512 MB
```

The budget model is a real slice — a 90 mm box at 0.1 mm layers and 25 % infill, **44.2 MB
of G-code**, 899 object layers, 1 516 347 segments, 26.0 MiB of compiled preview — not a
cube and not a synthetic buffer. It is never committed; it lives in the API's data volume
as an ordinary job. Chromium is launched with `--js-flags=--max-old-space-size=512`, the
generous end of what a renderer gets on a 4 GB Android phone, so "it did not crash" means
something. Measured there, 24 checks green: **peak JS heap 8 MB**, a default window of
614 KB and 34 915 segments, 199 ms to a painted window, and the deepest window the UI offers
(141 layers, 236 310 segments) totalling **41 MB** of heap plus instance buffers — against
~240 MB if the model were resident. Dragging the slider across all 900 layers and back gives
a median frame of 16.7 ms and **250 ms of JavaScript out of 30.6 s of main-thread work**.

That last split is the honest one. The container has no GPU, so SwiftShader rasterises every
frame on the same thread as the gesture and the worst frames are that, not this code — the
client's share is 0.8 %. What a real phone's GPU does with the other 99 % is not observable
here and is not claimed. Note too that `--max-old-space-size` does not bound typed-array
backing stores; the heap cap catches "decode 1.5 M segments into objects", and the window
cap in `state/preview.ts` is what bounds the buffers.

The test also decodes the same byte range itself and checks the drawn geometry equals the
G-code plus `extruder_offset` — 1.79 mm adrift if the correction were dropped.

Format, byte layout and the server half: [`docs/GCODE-PREVIEW-FORMAT.md`](docs/GCODE-PREVIEW-FORMAT.md).

And M6's settings overrides, the same way:

```bash
docker compose run --rm integration          # slices the same box twice and diffs the G-code
docker compose up -d api
node test/e2e/settings.mjs                   # 390x844, touch emulation, a real slice
```

`apps/api/src/settings.integration.test.ts` proves an override reaches the output for one
key of every widget family — float, enum, boolean **on and off**, and a per-extruder array
— by reading the value back out of the G-code's own resolved config block and checking the
toolpaths changed with it:

| override                       | preset     | effect on a 12 mm box                       |
| ------------------------------ | ---------- | ------------------------------------------- |
| `layer_height=0.28`            | 0.2        | fewer `; CHANGE_LAYER`s, Z steps of 0.28    |
| `sparse_infill_pattern=gyroid` | crosshatch | > 200 lines of toolpath difference          |
| `infill_combination=1` (on)    | 0          | whole infill passes removed                 |
| `enable_arc_fitting=0` (off)   | 1          | G2/G3 moves 107 → 8                         |
| `nozzle_temperature=235,235`   | 220        | all six `M104`/`M109` commands move to S235 |

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
