# M2 — the profile pipeline

Two build-time extractors in `tools/extractors` (`@orca-web/extractors`) and a read-only
query API in `packages/catalog` (`@orca-web/catalog`). Everything is keyed to the pinned
OrcaSlicer version, so a version bump regenerates rather than drifts.

**The write/read split is load-bearing.** `docs/REPO-LAYOUT.md` forbids anything in the
request path from importing `tools/*`, because those programs parse C++ source, walk a
79 MB profile tree and fetch over the network. The API needs the catalog at runtime, so
the read side lives in its own dependency-free package: `tools/extractors` _writes_ the
artefacts, `packages/catalog` _reads_ them, `apps/api` imports only the latter.

```
tools/extractors ──writes──▶ /generated/<version>/*.json ──reads──▶ packages/catalog
     (build time)                                                    │
                                                                     ├─▶ apps/api  CatalogProfileResolver  → --load-settings
                                                                     ├─▶ apps/api  GET /catalog, /catalog/presets
                                                                     └─▶ smoke.sh  flatten-cli.js
```

## Why this milestone exists

`docs/SPEC.md`, "VERIFIED CLI deviations" #1, measured against the pinned 2.4.2 binary:

> **The OrcaSlicer CLI does not resolve preset `inherits` chains — and fails silently.**
> `--load-settings` / `--load-filaments` apply only the keys _literally present_ in the
> file passed; every other key falls back to the compiled-in `PrintConfig` default.

| key                | raw `BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle.json` | flattened |
| ------------------ | ----------------------------------------------------- | --------- |
| `printable_area`   | 200 × 200                                             | 256 × 256 |
| `printable_height` | 100                                                   | 250       |
| `filament_density` | 0 → `used_g="0.00"`                                   | 1.26      |

…and the slicer still exits 0 with plausible-looking G-code. **Never hand a raw
`resources/profiles` file to the CLI.** Flatten it first.

## Running the extractors

**In the image this is already done.** The Dockerfile's `generate` stage runs both
extractors and bakes `/generated/<version>/` into the runtime image; `ORCA_GENERATED_DIR`
points at it. Build-time generation is deliberate — the running container then needs no
network, and the artefacts are provably the same OrcaSlicer release as the binary,
because both come from `ARG ORCA_VERSION`. A failing extractor fails `docker build`.

On a dev host:

```bash
# both, into /generated/<version>/
npm run -w @orca-web/extractors extract

# one at a time
npm run -w @orca-web/extractors extract -- config-schema
npm run -w @orca-web/extractors extract -- profile-catalog
```

Exit code is non-zero if any option defined upstream was not extracted, or if any
preset's `inherits` chain failed to resolve.

| env                  | default                     | meaning                                             |
| -------------------- | --------------------------- | --------------------------------------------------- |
| `ORCA_VERSION`       | `2.4.2`                     | pinned release; the runtime image sets it           |
| `ORCA_RESOURCES`     | `/opt/orcaslicer/resources` | the slicer's `resources` dir                        |
| `ORCA_GENERATED_DIR` | `<repo>/generated`          | output root (gitignored); `/generated` in the image |

Outputs (all gitignored, never hand-edited):

```
generated/
  upstream/<version>/src/libslic3r/*        # verified upstream sources, cached
  <version>/config-schema.json              # deliverable 1       472 kB
  <version>/profile-catalog.json            # deliverable 2         26 MB
  <version>/profile-catalog.report.json     # the unresolved-inheritance report
```

The image drops `upstream/` after generating — the sources are build inputs, not
runtime data — and keeps the three artefacts, 26 MB in total.

### Getting the inputs

**C++ sources** are fetched and SHA-256-verified by the extractor itself
(`src/upstream/sources.ts` holds the pins). `raw.githubusercontent.com` is the canonical
origin; a jsDelivr mirror is listed as an availability fallback for environments whose
egress policy blocks GitHub. Mirrors are untrusted — a checksum mismatch is a hard
failure, never a fallback.

Note for anyone reproducing the image build behind a restrictive egress policy:
`raw.githubusercontent.com` is the only host this step needs, and it is the one that
works. GitHub's tarball/codeload endpoints (`SOURCE_TARBALL_URL`) return 403 under some
policies — do not switch the build to them.

**`resources/profiles`** is not in the source pin: it comes from the pinned AppImage,
which the Dockerfile already keeps in the image
(`ORCA_RESOURCES=/opt/orcaslicer/resources`). Inside the container there is nothing to
do. On a dev host, copy it out of the built image:

```bash
docker create --name orca-profiles orcaslicer-web:dev true
docker cp orca-profiles:/opt/orcaslicer/resources/profiles \
          generated/upstream/2.4.2/resources/profiles
docker rm orca-profiles
export ORCA_RESOURCES="$PWD/generated/upstream/2.4.2/resources"
```

## Deliverable 1 — config schema

`generated/<version>/config-schema.json`, parsed from `src/libslic3r/PrintConfig.cpp` of
the pinned tag. Per option: `label`, `tooltip`, `enumChoices` (value **and** human
label), `min`/`max`, `category`, `units` (upstream's `sidetext`), `type`/`valueKind`,
`default`, and `mode` — the simple/advanced/expert/develop disclosure level that mirrors
Orca's own (`ConfigOptionMode`, default `comSimple`).

Three maps: `options` (preset keys, what M6 renders), `cliOptions` (`--flag`-only
definitions) and `placeholderOptions` (read-only placeholder-parser variables usable in
custom G-code). Plus `coverage` and `gaps`.

Idioms the parser is taught about, because upstream does not only use the plain
`def = this->add(...)` shape:

- `auto alias = def = this->add(...)` and later `def->enum_values = alias->enum_values;`
- `enum_keys_map` pointing at an `s_keys_map_X` table or at
  `ConfigOptionEnum<X>::get_enum_values()`
- the `filament_extruder_override_keys` loop (16 nullable `filament_*` twins of extruder
  options)
- the `machine_max_{speed,acceleration,jerk}_{x,y,z,e}` axis loop (12 real machine keys,
  with the per-axis defaults read from upstream's `AxisDefault` table)
- `#define`d defaults (`INITIAL_LAYER_HEIGHT`) and file-local constants (`max_temp`)
- `filament_type`'s dropdown, filled from `MaterialType::all()` in another file

### Cross-check against the binary

The 53 `--flag` definitions the parser finds in `CLI*ConfigDef` match
`test/golden/orca-slicer-help.txt` — the committed `--help` output of the pinned
binary — exactly, in both directions. That ties the parsed source to the shipped binary.

## Deliverable 2 — profile catalog

`generated/<version>/profile-catalog.json`: vendors → printer models → nozzle variants →
compatible process and filament presets.

**Resolution rule.** A preset's parent is the preset of the **same type** whose **name**
equals `inherits`, **within the same vendor** — not `<same-dir>/<inherits>.json`. That
distinction is the whole point: 1939 of 11 286 edges in 2.4.2 point outside the child's
own directory. Child keys override parent keys wholesale (no per-element array merging).

**Storage.** Each preset is stored with its _own_ keys plus its resolved chain, not with
a merged copy: merging is an `Object.assign` over 1–5 objects at query time, whereas
persisting merged copies would turn a 20 MB profile tree into hundreds of megabytes of
duplicated G-code strings. Resolution still runs over every preset at build time — that
is what produces the report and the compatibility index. Compatibility edges are stored
as indices into `machinePresetIds` for the same reason: there are ~550 000 of them, and
spelling out the preset ids costs 26 MB of artefact for no extra information. Use
`ProfileCatalogQuery.compatibleMachineIds()` to read them back. The catalog lands at
about 26 MB and parses in ~0.3 s.

**Compatibility** follows upstream's precedence (`Preset::is_compatible_with_printer`):
a non-empty `compatible_printers` list decides on its own and the
`compatible_printers_condition` is **not** evaluated. This is not pedantry — 14 Prusa
MK3S process presets name the right printer alongside a stale `nozzle_diameter[0]==0.4`
condition, and AND-ing the two hides all of them from the 0.25/0.6/0.8 nozzles.
Conditions are evaluated by a small parser covering `and`/`or`/`not`, parentheses,
`== != < > <= >=`, regex `=~` / `!~`, indexed keys and bare booleans. An expression it
cannot evaluate is treated as _unrestricted_ and listed in the report, so a preset never
disappears silently.

A vendor that ships no printers of its own is treated as a shared library — in 2.4.2
that is exactly `OrcaFilamentLibrary` — and its filaments are offered for every printer.

**The report** (`profile-catalog.report.json`) has:

- `unresolved` — the acceptance artefact: presets whose `inherits` chain failed
  (`missing-parent`, `inherits-cycle`). A non-empty list is a build failure.
- `structuralProblems` — files the vendor index does not reference, index entries with no
  file, duplicate preset names, non-preset json.
- `unevaluatedConditions` — compatibility expressions the evaluator did not understand.
- `presetsWithNoCompatiblePrinter` — selectable presets that match no shipped printer.

## Deliverable 3 — the query API (`@orca-web/catalog`)

```ts
import { openProfileCatalog } from '@orca-web/catalog';

const catalog = openProfileCatalog({ includeSchema: true }); // once, at start-up

// "every process preset valid for a Bambu Lab H2S with a 0.4 nozzle", fully resolved
const presets = catalog.processPresetsFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
presets[0].name; // "0.08mm High Quality @BBL H2S"
presets[0].config.layer_height; // "0.08"  — resolved through the chain

catalog.filamentPresetsFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
catalog.machinePresetFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
catalog.flattenForSlicer(presetId); // -> write next to the job, pass to --load-settings
```

`openProfileCatalog` and everything it returns are pure data access over the generated
JSON — no network, no C++ parsing, no directory walking. The build-time halves
(`buildConfigSchema`, `buildProfileCatalog`) live in `@orca-web/extractors` and are the
parts that must never be called from the request path; the package boundary is what
enforces it.

## Deliverable 4 — flattening presets for the CLI

`ProfileCatalogQuery.flattenForSlicer(id)` returns the fully resolved preset with
`inherits` and `instantiation` removed. Two callers, one implementation:

- **`apps/api/src/profiles/catalog-resolver.ts`** — `CatalogProfileResolver`, the
  `ProfileResolver` adapter M1's port was designed for. Registered in `app.ts`; every
  `POST /jobs` resolves its machine/process/filament refs through it, and the result is
  what `--load-settings` / `--load-filaments` receive. It memoises per preset id, freezes
  the values it hands out, and maps a missing preset to `ProfileNotFoundError` (404) and
  anything else to `ProfileResolutionError` (400).
- **`packages/catalog/src/flatten-cli.ts`** — the container-side entry point
  `scripts/smoke.sh` uses. Same code path, so the smoke test proves the production
  resolver rather than a shell-script lookalike.

`engine/orca/orca-cli-engine.ts` keeps two defensive assertions regardless: it refuses a
profile that still carries `inherits`, and it fails a slice whose `slice_info.config`
reports `used_g = 0`. That number is deviation #1's signature symptom — an unflattened
filament preset leaves `filament_density` at 0 and the CLI still exits 0 — so it stays as
a backstop even though the resolver should make it unreachable.

## HTTP surface

Both routes are static per OrcaSlicer version, so both are served from a pre-serialised
string with a strong ETag (`"<sha256 of version + query>"`),
`Cache-Control: public, max-age=3600, stale-while-revalidate=604800`, and a 304 on
`If-None-Match`. Loading and serialisation happen once, at start-up / first request —
see `apps/api/src/catalog/service.ts`.

### `GET /catalog[?schema=1]`

`CatalogResponse`: `orcaVersion`, `generatedAt`, `counts`, `vendors[]`,
`printerModels[]` (each with its `nozzleVariants[]`), plus `configSchema` when
`?schema=1`. **351 kB, 708 kB with the schema** — it deliberately omits the 11 551 preset
bodies. `counts.resolved === counts.presets` is the acceptance property: nothing failed
to resolve at build time.

### `GET /catalog/presets?type=process|filament&model=…&nozzle=…[&vendor=…]`

`ResolvedPresetView[]`, ordered by name, abstract (`instantiation: false`) presets
excluded. Each entry is `{ id, name, type, vendor, file, chain, instantiable, config }`
where `config` is the **fully resolved** key/value map — for the H2S 0.4 process presets,
166–167 keys each, and never an `inherits`.

- `type` missing or not `process`/`filament` → `400 BAD_REQUEST`.
- unknown `model` → `404 NOT_FOUND`, with near-matches in `hint`.
- a `nozzle` the printer does not have → `404 NOT_FOUND`, with the real ones in `hint`.
- artefacts missing (a broken build) → `503 ENVIRONMENT_ERROR`.

`GET /healthz` reports which resolver is wired in and what the catalog holds, so
"is this container serving the catalog?" is one request.

### Notes for M3 — how the UI should drill down

One `GET /catalog` at start-up gives the whole picker tree; everything after that is a
preset query.

1. **Printer.** `printerModels[]` is the flat list, each with `id`, `name`, `vendor` and
   `nozzleVariants[]`. Group by `vendor` for display; `vendors[]` carries the display
   name (`BBL` → `Bambulab`). 384 models in 2.4.2, so the list needs a search field.
2. **Nozzle.** `model.nozzleVariants[]` — the variants that actually exist, which is not
   always `advertisedNozzleDiameters`. Show `variant` (`"0.4"`, `"0.4HF"`); pass it back
   verbatim as `nozzle`.
3. **Process and filament.** Two calls to `/catalog/presets`, differing only in `type`.
   Pass `vendor` too when two vendors ship a model of the same name.
4. **Submitting.** `POST /jobs` wants `PresetRef`s (`{ kind, vendor, name }`), not ids —
   split a `ResolvedPresetView.id` on `/`, or read `vendor` and `name` off the view
   directly. The machine ref is `nozzleVariants[n].machinePresetName` with the model's
   `vendor`.

Sizes to design against: process lists are small (7 for the H2S 0.4), filament lists are
not (392 presets, 1.3 MB, because `OrcaFilamentLibrary` is offered for every printer).
Filter client-side after one fetch — it is cacheable and version-stable — rather than
round-tripping per keystroke.

## Notes for M6 (generated settings UI)

- Group by `category`; options with no `category` are internal and are not shown in
  Orca's own settings pages either.
- Reveal by `mode`: `simple` ⊂ `advanced` ⊂ `expert`. **Never render `develop`** — that
  is upstream's hidden/debug tier.
- `valueKind` picks the widget; `isArray` means the value is a per-extruder/per-filament
  vector, so the control is a list, not a scalar.
- `units` is the suffix to render after the field (`mm`, `mm/s`, `mm/s²`, `℃`, `%`).
- `enumChoices` is ordered as upstream orders it; render `label`, submit `value`.
- `nullable` options accept "unset" (they are the `filament_*` overrides of an extruder
  setting); `derivedFrom` names the extruder option they override.
- `default` is the compiled-in `PrintConfig` default — the value the CLI would silently
  fall back to. It is _not_ the preset's value; take that from the resolved preset and
  diff against it to show "modified from preset".
- One option, `extruder_printable_area`, has type `coPointsGroups`, which the schema
  reports as `valueKind: "unknown"`. It cannot be rendered generically.
