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

## VERIFIED CLI deviations — measured against OrcaSlicer 2.4.2 in M0

The reference section above was supplied by production users. The following were
**empirically verified against the pinned binary in our own container** and take
precedence over it where they conflict. Read these before writing any code that
touches the CLI.

1. **The CLI does not resolve preset `inherits` chains — and fails silently.**
   This is the most important finding in the project. `--load-settings` /
   `--load-filaments` apply only the keys *literally present* in the file passed;
   every other key falls back to the compiled-in `PrintConfig` default. Measured:
   slicing with the stock `BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle.json` gave
   `printable_area` 200×200 instead of 256×256, `printable_height` 100 instead of
   250, and `filament_density` 0 → `used_g="0.00"`. It still **exits 0 and
   produces plausible-looking G-code.** Flattening the chain first fixes all of
   it. Consequences:
   - **Profiles must be fully flattened before they reach the CLI. Never hand a
     raw `resources/profiles/` file to the slicer.**
   - `scripts/resolve-profile.mjs` is the M0 stopgap resolver. **M2's profile
     catalog owns this properly** and replaces it.
2. **Never combine `--outputdir` with an absolute `--export-3mf` path.** They are
   concatenated (`/work/out//work/out/x.3mf`) and the export fails with
   `return -13`, producing no artefact.
   *Measurements disagree on the exit status:* M0 observed exit **0**; M1
   observed exit **243** (which is `-13` truncated to 8 bits, see #8). We have not
   isolated what differs between the two runs. **The code therefore assumes
   neither** — it checks the exit status *and* asserts the artefact exists and is
   non-empty. Treat "exit code alone is never a sufficient success signal" as the
   durable rule here; it holds whichever measurement is right.
3. **`--filament-colour` is not an advertised flag in 2.4.2's `--help`**, despite
   appearing in the canonical invocation above. It presumably still works as a raw
   `PrintConfig` key (`filament_colour`); verify before relying on it.
4. **G-code shape breaks naive regexes.** E values are emitted with no leading
   digit (`E.02345`), and arc fitting turns a share of extrusions into `G2`/`G3`.
   A `^G1 .*E[0-9]` match found 8 lines out of 6946 real extrusions. Critical for
   M5's parser.
5. **`--min-save` omits `Metadata/plate_1.png` entirely** rather than writing a
   blank one, and drops `3D/Objects/*.model`. The thumbnail-rewrite path must
   handle **absent**, not merely blank.
6. **`slice_info.config`'s `first_layer_time` is uninitialised garbage**
   (e.g. `16745348785772691456.000000`). Use `prediction` (seconds) and the
   per-filament `used_m` / `used_g` attributes only.
7. **Set `XDG_RUNTIME_DIR`** or every run emits `error: XDG_RUNTIME_DIR is invalid
   or not set` to stderr. Non-fatal, but it pollutes stderr parsing. The image
   already sets it.

### Added in M1 — measured while building the engine adapter

8. **Negative exit codes reach the shell truncated to 8 bits.** Upstream returns
   `-3`, `-5`, `-13`; the shell sees `253`, `251`, `243`. **A lookup table keyed on
   the raw status matches nothing.** Normalise before mapping. The full 46-code
   table lives in `apps/api/src/engine/orca/exit-codes.ts`, taken from upstream
   `src/libslic3r/Utils.hpp` at v2.4.2.
9. **Every invocation writes `result.json` into the current working directory —
   including `--help`.** `--load-assemble-list` additionally drops `NNNNN.log` and
   a raw `plate_N.gcode` there. **Setting the child process's `cwd` to the sandbox
   is load-bearing, not cosmetic**; this littered the repo root twice before
   `probe()` was pinned to a scratch directory.
10. **The progress pipe usually omits `warning` entirely rather than sending
    `null`**, and emits far fewer lines than you would expect. **How few is not
    stable**: M1 measured 9 frames for a cube starting around 35 %; M3
    re-measured the same shape and got **2 frames, the first at 70 %**. Treat the
    stream as *arbitrarily sparse and arbitrarily late* — that is the durable
    lesson, and it is what the UI is built against. Never assume a smooth 0→100
    ramp, and never treat a long silence as a stall. Note also that a plate
    boundary can reset `plate_percent`, so percent must be clamped monotonic
    before display.
11. **admesh's ASCII/binary STL sniffing is fragile.** A byte > 127 must appear
    within 128 bytes of offset 80. A small box with zeroed normals fails with
    `CLI_DATA_FILE_ERROR` at 10 mm and 15 mm but loads fine at 19 mm and 20 mm.
    Emitting real normals fixes it. **Relevant to any geometry we generate
    server-side (M4).**
12. Upstream's own error message strings are written for a Bambu upload pipeline
    and are misleading in our context. Never forward them to the user; map to our
    own typed errors. A stderr diagnostic match should beat the exit-code table
    (that is how the `G92 E0` / relative-extruder case is detected).

### Added in M4 — measured while building the plater

13. **`--arrange 1` cannot be combined with `--load-assemble-list`.** The run fails
    immediately with `-2` (`CLI_INVALID_PARAMS`, shell status 254) and produces no
    output, with or without `--slice`, with or without `--load-settings`. Arranging
    therefore takes **positional model paths** — one per *instance*, since the assemble
    list's `count` has no equivalent — and the placements are read back out of the
    exported project 3MF. `apps/api/src/engine/orca/orca-cli-engine.ts#arrange` does this.
14. **`pos_x`/`pos_y`/`pos_z` translate the model's own file coordinates.** They do
    *not* place the object's centre. MEASURED: a 20 mm box whose STL spans 0…20, sent at
    `pos_x = 80`, extrudes across x 80…100; an STL that spans 100…120 sent at the same
    value lands at 180…200. Every plater in existence talks in centres, so the conversion
    (`centre − ½·bbox`) is real work and getting it backwards offsets every object by
    half its size — plausibly, and silently.
15. **G-code coordinates are plate coordinates minus `extruder_offset`.** A stock BBL
    X1C ships `extruder_offset = ["0x2"]`, so an object centred at y = 120 on the plate
    extrudes at y = 118. Nothing in the plate description applies this; the firmware
    does. **M5's preview must apply the same offset** or the toolpaths will sit 2 mm off
    the objects they belong to.
16. **An object whose underside is above the bed fails the slice outright** — exit
    `-100` (`CLI_SLICING_ERROR`, shell status 156), not a warning and not an auto-drop.
    So "drop to bed" is not a convenience: a plater must always send a `pos_z` that puts
    the geometry's lowest point at z = 0.
17. **Filament slot 2 on a single-nozzle machine is rejected**, with
    `Grouping error: PLA can not be placed in the right nozzle` and exit `-100`. 2.4.2
    reads a second slot as a second *nozzle*, not as an AMS slot. Multi-material plates
    need more than an index in `filaments`.
18. Deviation #5 re-confirmed on the same binary: a `--min-save` archive has **12
    members and no `Metadata/plate_N.png`**. The rewrite therefore *adds* the member —
    and has to add `<Default Extension="png">` to `[Content_Types].xml` at the same time,
    or the result stops being a valid 3MF.

### Added in M5 — measured while building the G-code preview parser

19. **The G-code marker set is not the one this brief assumed.** M5's description says
    feature type comes from `;TYPE:` comments and layer boundaries from `;LAYER_CHANGE` /
    `;Z:`. 2.4.2 emits **none of those**. It writes `; CHANGE_LAYER`, `; Z_HEIGHT: 0.2`,
    `; LAYER_HEIGHT: 0.2`, `; FEATURE: Outer wall` and `; LINE_WIDTH: 0.393713` — all with
    a leading space. A parser keyed on the assumed spellings produces one layer of
    untyped segments **and passes every smoke test**. The full measured set and the
    role-name table are in docs/GCODE-PREVIEW-FORMAT.md.
20. **Custom G-code blocks are copied into the output verbatim, indentation included.**
    Machine start/end G-code from the profile arrives as `    G1 X65.000 E1.24726 F2015.5`.
    Treating a leading space as "probably a comment" silently drops the prime line — 105
    moves and 585 mm of deposited material — and nothing counts it. Skip leading
    whitespace before deciding what a line is.
21. **`T1000`, `T1100` and `T255` are not tool changes.** Bambu machine G-code uses them
    as control codes in the start and end blocks. A naive `^T(\d+)` colours the whole
    model as extruder 1000. Only accept a small tool index (`packages/gcode` cuts at 64).
22. **`--scale` segfaults.** `orca-slicer … --scale 2 …` dies with SIGSEGV in ~0.1 s, at
    any factor tried, on an STL that slices fine without it. Scale geometry before it
    reaches the CLI; do not offer a scale flag through to the binary.
23. **Boolean `PrintConfig` keys are switches, not flags with a value.**
    `--use-relative-e-distances 0` is rejected with `No such file: 0` — the `0` is taken
    as a positional model path — and `--enable-support 1` the same way. Pass the bare flag
    to turn one on, and the `=` form (`--use-relative-e-distances=0`) to turn one off.
    *M6 generalised this: see #28. The `=` form works for every option type and for
    `coBools` vectors too, so the code uses it uniformly rather than special-casing
    booleans at the call site.*
24. **Multi-filament jobs could not be made to slice at all.** Independently corroborates
    #17, which M4 hit from the other direction. Two filaments on one plate
    fail three different ways, none of them ours: BBL machine profiles reject it with
    `Grouping error: PLA can not be placed in the right nozzle` (exit 156 = -100) even on
    a single-nozzle P1S; adding `--filament-map-mode Manual --filament-map "1,1"`
    segfaults; and a genuinely multi-tool machine (Prusa XL 5T) segfaults too. Two PLAs
    with different temperatures are additionally rejected up front with a mixed-temperature
    error. **This blocks any multi-material work and needs isolating before M4's
    per-object filament assignment can be trusted end to end.** The preview parser tracks
    tool index and is exercised against the pseudo-tools of #21, but no real `T0`/`T1`
    output exists to test against yet.

### Added in M5 (client) — measured while building the three.js preview

25. **The prime line makes the toolpath's bounding box the size of the bed, not of the
    object.** MEASURED on the 44 MB budget slice: a 90 mm box occupies x 83…173, y 83…173,
    but the compiled index reports `bounds` x **45…225**, y **4…175** — the 585 mm priming
    pass of #20 runs the full width of the plate at y = 4 before layer 1. Two consequences,
    both hit while building the client: framing a camera on `bounds` zooms out to fit a line
    nobody is looking at (the preview frames the loaded layers instead), and the quantisation
    grid spans the prime line as well, so docs/GCODE-PREVIEW-FORMAT.md's "a 90 mm object gets
    1.5 µm steps instead of 3.9" measured **2.75 / 2.62 µm** in practice. Nothing is broken —
    that is still three orders of magnitude finer than the 0.42 mm line being drawn — but
    anything that reads `bounds` as "where the object is" is wrong by most of a plate.
26. **`extruder_offset` is confirmed from the other side.** #15 was measured by comparing
    plate positions with G-code; M5 measures the same 2 mm the other way round. The preview's
    drawn geometry, decoded independently from the compiled `.bin`, spans y 83.00…173.00 mm
    where the G-code says y 81.21…170.79 — exactly `+2` plus the half line width a drawn
    extrusion adds either side of the centreline. Without the correction the toolpath sits
    **1.79 mm** from the object it belongs to, which is small enough to look like a rendering
    artefact and is not one. `test/e2e/preview.mjs` asserts both the corrected value and the
    uncorrected one, so removing the correction fails rather than merely looking slightly off.

### Added in M6 — measured while building the settings UI

27. **Vector-valued `PrintConfig` flags do not use the `;` separator the rest of the CLI
    does, and getting it wrong is silent.** `--load-settings`, `--load-filaments` and
    `--filament-colour` take `;`-separated lists, so `;` looks like this CLI's convention.
    It is not the convention for config keys. MEASURED, reading the values back out of
    `Metadata/project_settings.config`:
    - `--nozzle-temperature=235,240` → `["235","240"]`. `--nozzle-temperature=235;240` →
      **`["235"]`, at exit 0** — every element after the first is silently discarded.
    - `--printable-area=0x0,180x0,180x180,0x180` → four points.
      `--printable-area=0x0;180x0;…` → **exit 206 (`-50`), no artefact at all.**
    - String vectors are the other way round: `--filament-notes=hello; world` →
      `["hello","world"]`, `--filament-notes=hello, world` → `["hello, world"]`.

    That is libslic3r's own split — `ConfigOptionVector<std::string>` unescapes a
    `;`-separated list, every other vector type reads a `,`-separated one — and it means a
    serialiser has to choose per element type. `apps/api/src/engine/orca/overrides.ts`
    does; `overrides.test.ts` pins it.
28. **`--key=value` works for every option type, and is the only form that works for all
    of them.** This subsumes #23 rather than contradicting it. Deviation #23 found that a
    boolean takes the bare flag to turn on and the `=` form to turn off; the reason is that
    boost registers every `coBool` **and `coBools`** key with an implicit value, so the
    following token is taken as a positional model path. MEASURED: `--filament-soluble
    "1,0"` fails with `No such file: 1,0` exactly as `--use-relative-e-distances 0` does,
    while `--filament-soluble=1,0` is accepted. The `=` form was verified working for
    `coFloat`, `coInt`, `coEnum`, `coPercent`, `coBool`, `coBools`, `coInts`, `coFloats`,
    `coPoints` and `coString` (multi-line custom G-code included), and for negative numbers
    where the two-token form would look like a flag. **One argv token per override,
    always.**
29. **`--key=` with an empty value is rejected AND eats the next argument.** MEASURED:
    `--filament-notes=` exits 253 reporting `No such file: /work/…/out.gcode.3mf` — i.e.
    it consumed the `--export-3mf` path. An empty string is a legal value for a string
    option, so it is the one case that must go back to the two-token `--key ""` form (safe
    precisely because no string option is a switch). `--filament-notes ""` yields `[]`.
30. **`--seam-position rear` is rejected with `Invalid value for option --seam-position`
    (exit 254).** Enum values are validated by the CLI, so an enum widget must submit
    `enumChoices[].value` verbatim and nothing else. Worth stating because the failure is
    at parse time, before any slicing, and the message is buried in a `--help` dump.
31. **G-code output is byte-for-byte reproducible except for one line.** Two identical
    invocations differ only in `; generated by OrcaSlicer 2.4.2 on <date> at <time>`. That
    makes "diff the G-code" a usable acceptance technique — which is what M6's acceptance
    test does — provided that line is excluded.

### Environment notes for local development
- The Docker daemon is not running at session start in the dev container; start it
  with `nohup dockerd &` (sandbox disabled).
- Container HTTPS is TLS-intercepted in this environment, so
  `docker/extra-ca-certificates/ccr-proxy.crt` (gitignored) must exist locally for
  `docker compose build` to fetch anything. It is a no-op on a clean machine and
  in CI.

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
