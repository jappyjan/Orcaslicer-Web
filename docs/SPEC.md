# OrcaSlicer Web — Project Specification

> This is the authoritative brief for the project. Every contributor (human or agent)
> should read this file in full before making changes. It is ground truth; do not
> re-derive the OrcaSlicer CLI behaviour documented below.

## Mission

A self-hostable web application that lets a user slice 3D models from a phone or
tablet browser. Slicing is performed server-side by the **unmodified upstream
OrcaSlicer binary driven through its CLI**. We build the frontend, the API, the
profile pipeline, and the job orchestration. We do **not** fork or patch
OrcaSlicer's C++.

Target deployment: a single Docker Compose stack on a small VPS
(Coolify-compatible), single-tenant or small-team. Not a public SaaS.

## Hard constraints

1. **Do not fork OrcaSlicer. Do not link against `libslic3r`.** Shell out to a
   pinned, unmodified release binary as a separate process. This keeps the
   AGPL-3.0 boundary clean and makes upstream upgrades a version bump instead of
   a rebase.
2. **Pin the OrcaSlicer version** in the Dockerfile as an explicit `ARG`. The CLI
   surface changes between releases without release-note mentions. A CI check
   runs `orca-slicer --help` and diffs it against a committed golden file,
   failing loudly on drift.
3. **Isolate the slicer behind an interface.** A `SlicerEngine` port
   (`slice(job): AsyncIterable<Progress> -> Artifacts`) with `OrcaCliEngine` as
   the first adapter. PrusaSlicer and Bambu Studio have near-identical CLIs; do
   not hardcode Orca assumptions above this layer.
4. **Every slice runs in a disposable sandbox directory.** A single job can leave
   200–500 MB of intermediates. Create `/work/{jobId}/`, `rm -rf` it in a
   `finally` block that runs on success, failure, timeout, and cancellation
   alike. A disk-exhaustion bug here takes the host down within hours of real use.
5. **Mobile is the primary target, not a responsive afterthought.** Every
   interaction must work with a thumb on a 390px-wide viewport. Desktop is the
   degraded case. If a feature cannot be made touch-native, cut it rather than
   shipping a mouse-shaped UI.

## Non-goals — do not build these

- Parity with the OrcaSlicer desktop UI. Aim for the ~20% of features that cover
  ~90% of everyday slicing.
- Support / seam / MMU painting tools (phase 2 at the earliest — note the data
  path in the design, build nothing).
- Calibration test generators, printer network/LAN control, camera streams, AMS
  management.
- Client-side or WASM slicing. Slicing happens on the server. Do not attempt to
  compile libslic3r to WebAssembly.
- Account systems, billing, multi-tenancy.

## Stack decisions (settled — do not relitigate)

- **Backend:** TypeScript on Node 22, Fastify.
- **Queue:** a `JobQueue` port. The default shipped adapter is **in-process with a
  documented concurrency limit**. A **BullMQ/Redis adapter is stubbed behind the
  same interface**, selected by env var, so the swap is a config change rather
  than a refactor.
- **Model storage:** uploaded models **persist** in a content-addressed model
  library so a model can be re-sliced with different settings without
  re-uploading (this matters enormously on mobile). Enforce a configurable
  total-bytes quota plus an LRU/TTL sweeper so disk cannot run away. Job
  sandboxes under `/work` remain strictly ephemeral regardless.
- **Frontend:** React + Vite + TypeScript, Tailwind, three.js for both the plater
  and the G-code preview.
- **Progress transport:** Server-Sent Events.
- **Metadata storage:** filesystem + SQLite. No cloud dependencies.
- **Container:** one image containing the OrcaSlicer binary and the Node API;
  frontend built as static assets served by the API.

---

## Reference: how the OrcaSlicer CLI actually works

Ground truth gathered from production users. Use it instead of rediscovering it.

### Canonical invocation

```bash
orca-slicer \
  --slice 1 \
  --load-settings "machine.json;process.json" \
  --load-filaments "filament1.json;filament2.json" \
  --filament-colour "#FF0000;#0000FF" \
  --allow-newer-file \
  --min-save \
  --debug 2 \
  --pipe /work/{jobId}/progress.pipe \
  --export-3mf /work/{jobId}/out.gcode.3mf \
  input.3mf
```

- `--slice 0` slices all plates; `--slice N` slices plate N.
- **Order matters in `--load-settings`: machine first, then process.**
- Settings priority, highest to lowest: (1) command-line flags,
  (2) `--load-settings` / `--load-filaments` files, (3) values embedded in the
  input 3MF. Any key from `src/libslic3r/PrintConfig.cpp` can be passed directly
  as a flag, e.g. `--layer-height 0.1`.
- `--allow-newer-file` is effectively mandatory; the CLI reports a stale version
  string and rejects files without it.
- `--min-save` keeps the output archive small. Use it.

### Building a plate without authoring a 3MF: `--load-assemble-list`

This is the preferred input path — the frontend sends geometry references plus
transforms, the backend writes this JSON, and no client-side 3MF authoring is
required.

```json
{
  "plates": [{
    "plate_index": 1,
    "plate_name": "plate_1",
    "need_arrange": false,
    "plate_params": {},
    "objects": [
      {
        "path": "/work/{jobId}/models/1.stl",
        "count": 1,
        "filaments": [1],
        "assemble_index": [1],
        "pos_x": [120.0],
        "pos_y": [120.0],
        "pos_z": [0.0],
        "subtype": "ModelPart",
        "print_params": { "support_type": "normal(auto)" },
        "height_ranges": []
      }
    ]
  }]
}
```

Field notes:

- `filaments` is 1-based slot indices; length must be 1 (applies to all copies) or
  equal to `count`.
- `assemble_index`: objects sharing a value are merged into one composed model —
  this is how you build multi-part objects from separate STLs.
- `subtype` accepts `ModelPart`, `NegativeVolume`, `ParameterModifier`. This is
  the hook for modifier volumes later.
- `pos_x` / `pos_y` are only honoured when `need_arrange` is `false`.
- `height_ranges` entries are `{min_z, max_z, range_params}`.

### Progress streaming: `--pipe`

Create a FIFO with `mkfifo`, start a reader **before** launching the slicer, pass
the path to `--pipe`. Each line is one JSON object:

```json
{
  "plate_index": 0,
  "plate_count": 1,
  "plate_percent": 47.3,
  "total_percent": 47.3,
  "message": "Generating supports",
  "warning": null
}
```

Throttle to roughly one update every 1–2 seconds before forwarding to the client.
Surface `warning` values in the UI — they are the user's only signal for things
like unsupported overhangs.

### Output: it is a `.gcode.3mf`, not a `.gcode`

`--export-3mf` writes a ZIP archive:

```
Metadata/
  plate_1.gcode           # the actual G-code
  plate_1.png             # thumbnail — REQUIRES OPENGL, BLANK IN HEADLESS MODE
  slice_info.config       # filament usage (mm and grams per slot), time estimate, layer count
  project_settings.config # fully resolved settings
  model_settings.config   # object placement and metadata
3D/
  3dmodel.model
```

- Parse `slice_info.config` for the results panel. Do **not** parse G-code to
  compute time/material — the numbers are already here.
- Offer both downloads: the raw extracted `.gcode` and the `.gcode.3mf` (Bambu
  printers prefer the latter).
- **The blank thumbnail is our problem to solve.** Render a plate preview from the
  WebGL view client-side, upload it as PNG, and rewrite `Metadata/plate_N.png`
  inside the archive before serving it. Otherwise printer displays show an empty
  preview.

### Other gotchas — each needs a regression test or an explicit code comment referencing it

- `printer_model` in the input 3MF's `Metadata/project_settings.config` must match
  the `printer_model` in the machine JSON, or slicing fails or silently
  misbehaves. When re-targeting a project to a different printer, patch it before
  slicing.
- Some community profiles fail with a "Relative extruder addressing requires
  resetting the extruder position" error; the fix is ensuring `G92 E0` is present
  in the layer-change G-code of the process profile. Detect this error string and
  surface an actionable message rather than a raw stderr dump.
- Exit codes are meaningful and defined in `src/OrcaSlicer.cpp`. Map them to typed
  errors; never show the user a bare non-zero exit.
- Enforce a wall-clock timeout per job and kill the **process group** on expiry.
  `--mstpp` (max seconds per plate) and `--mtcpp` (max triangles per plate) exist
  as engine-side guards; use them as a second line of defence.

---

## Milestones

Delivered in order. Each milestone must be independently runnable and
demonstrable before moving on. Commit at each boundary.

### M0 — Container and smoke test
Dockerfile with a pinned OrcaSlicer (extract the AppImage; no GUI, no VNC). A
shell script that slices a bundled test STL with bundled profiles and asserts
non-empty G-code plus a parseable `slice_info.config`. Committed golden `--help`
output.

**Done when:** `docker compose run smoke` passes on a clean machine with no
display server.

### M1 — Slice service
HTTP API: `POST /jobs` (multipart: model files + a job descriptor) → `202` with
job id. `GET /jobs/:id/events` (SSE progress). `GET /jobs/:id/artifacts/:name`.
`DELETE /jobs/:id` cancels and cleans up. Concurrency-limited queue. Sandbox
lifecycle with guaranteed cleanup. Typed error mapping.

**Done when:** an integration test slices three models concurrently, streams
progress for each, and leaves zero bytes behind in `/work` afterwards.

### M2 — Profile pipeline
Two build-time extractors:
1. **Config schema.** Extract option definitions from `PrintConfig.cpp` (labels,
   tooltips, enum values and their labels, min/max, category, units, type) into a
   JSON schema the frontend renders forms from. Parse the source of the pinned
   tag rather than hand-maintaining a list; regenerate on version bump.
2. **Profile catalog.** Walk `resources/profiles/`, resolve `inherits` chains
   fully, and emit a flat, queryable catalog of vendors → printers → nozzle
   variants → compatible process and filament presets.

Serve both via `GET /catalog`. Cache aggressively; this is static per Orca
version.

**Done when:** the API can answer "give me every process preset valid for a Bambu
Lab H2S with a 0.4 nozzle" with fully resolved values, and a report lists any
profiles whose inheritance failed to resolve.

### M3 — Minimum usable web app
Upload STL/3MF → pick printer / filament / process from the catalog → slice with
live progress → results panel (time, grams, metres, layer count) → download. No
3D view yet. Full-width touch targets, no hover-dependent affordances.

**Done when:** you can slice a model end-to-end from a phone browser and the
result prints correctly on real hardware.

### M4 — Touch plater
three.js scene with the build plate. Load and display meshes. Touch gestures:
one-finger orbit, two-finger pan/zoom, tap to select. Transform via an explicit
mode toggle (move / rotate / scale) with on-screen sliders and numeric fields —
**not** desktop-style drag gizmos, which are unusable with a thumb. Duplicate,
delete, lay-flat, drop-to-bed, auto-arrange (delegate to `--arrange 1`).
Serialise the scene to an assemble-list.

**Done when:** a two-object plate arranged entirely on a phone slices to the exact
positions shown on screen.

### M5 — G-code preview
The hardest piece. Do not render raw G-code text in the browser.
- Server-side: parse the G-code once into a compact binary format — per-layer
  chunks of extrusion segments with position, width, height, feature type, and
  tool index. Emit a per-layer index so the client can range-request.
- Client-side: three.js rendering with instanced or merged geometry, one draw call
  per layer or per feature-type bucket. A layer-range slider that loads only the
  visible window; never hold the whole model in memory on mobile.
- Explicit budget: a 40 MB G-code file must open on a 4 GB phone without crashing
  the tab. Test against that, not against a laptop.

**Done when:** the budget test passes and the layer slider stays responsive while
scrubbing.

### M6 — Generated settings UI
Render forms from the M2 schema, grouped by category, with a
simple/advanced/expert disclosure level mirroring Orca's. Show which values are
modified from the preset. Diff-and-override: send only changed keys as CLI flags
rather than writing new profile files. Save named user presets.

**Done when:** any option exposed by the schema is editable and demonstrably
affects the output G-code.

---

## Working agreement

- The architecture decision record for the engine-adapter boundary is written
  **before** M1, not after.
- Integration tests run against the real binary in the container. Mocking the
  slicer for the happy path is acceptable in unit tests; the CI suite must include
  at least one real slice.
- Every gotcha listed above gets a regression test or an explicit code comment
  referencing it.
- No feature creep into the non-goals. If a task starts pulling toward painting
  tools or WASM, stop and flag it.
- `AGPL-NOTICE.md` documents the version of OrcaSlicer shipped, where its source
  can be obtained, and the process-boundary rationale.
