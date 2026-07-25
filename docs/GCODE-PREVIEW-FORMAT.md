# The G-code preview format

> The server-side half of M5. `packages/gcode` compiles a plate's G-code into this
> format once; `apps/api` serves it; the three.js client reads it a layer window at a
> time. `packages/gcode/src/format.ts` is the normative definition — this document is
> the reasoning.

## The requirement that decides everything

SPEC's M5 budget: **a 40 MB G-code file must open on a 4 GB phone without crashing the
tab.** Not "must load quickly on a laptop". The consequences fall out of that one line:

- The client must be able to hold **a window of layers**, never the model. So the data
  has to be addressable by layer without an index structure the client must first parse
  in full.
- What it does hold has to be **GPU-shaped on arrival**. A phone that decodes 1.5 million
  segments into 1.5 million JavaScript objects has already lost — that is ~200 MB of heap
  before a single triangle exists. So: fixed-size records, typed-array views, no parsing.
- Bytes moved matter more than bytes stored. The server has disk; the phone has a mobile
  connection and a 4 GB memory ceiling shared with the browser.

Measured on the real 42 MiB budget file (see "Measurements"): a layer window costs
**~30 KB**, and the whole compiled model is **26 MiB** — but the client never needs all of
it at once.

## Shape

Two files per plate, written next to the job's other artefacts:

```
<dataDir>/artifacts/{jobId}/plate_1.gcode           the source (published by M1)
<dataDir>/artifacts/{jobId}/plate_1.preview.json    the index
<dataDir>/artifacts/{jobId}/plate_1.preview.bin     the layer chunks
```

The `.bin` is layer chunks concatenated in print order, nothing else — no file header, no
per-layer header, no padding. A chunk is `count` fixed-size records. Everything needed to
locate a chunk is in the index, so a byte range **is** a layer window and the client turns
the response straight into typed-array views.

## The segment record — 18 bytes, little-endian

| offset | type     | field     | meaning                                          |
| -----: | -------- | --------- | ------------------------------------------------ |
|      0 | `uint16` | `x0`      | start, quantised                                 |
|      2 | `uint16` | `y0`      |                                                  |
|      4 | `uint16` | `z0`      |                                                  |
|      6 | `uint16` | `x1`      | end, quantised                                   |
|      8 | `uint16` | `y1`      |                                                  |
|     10 | `uint16` | `z1`      |                                                  |
|     12 | `uint16` | `width`   | extrusion width, µm. `0` = the slicer never said |
|     14 | `uint16` | `height`  | layer height, µm. `0` = the slicer never said    |
|     16 | `uint8`  | `feature` | `FeatureType`, see below                         |
|     17 | `uint8`  | `tool`    | 0-based extruder index                           |

**Little-endian** because every platform that will ever run the client is, and because
`Uint16Array` over an `ArrayBuffer` is little-endian on those platforms — reading it any
other way would mean a `DataView` and a per-field function call.

**18 bytes, and the even size is the point.** The record is exactly two views:

```js
const u16 = new Uint16Array(buf, byteOffset, count * 9); // positions, width, height
const u8 = new Uint8Array(buf, byteOffset, count * 18); // feature, tool
// segment i:
const x0 = origin[0] + u16[i * 9 + 0] * scale[0];
const feature = u8[i * 18 + 16];
```

No `DataView`, no object per segment, no copy. Widening the record to 20 bytes for
"nicer" 4-byte alignment would cost 11 % of every transfer to buy nothing: the format has
no 32-bit fields to align.

### Only extrusions

Travels are not stored. They are roughly a third of the moves and none of the printed
object; a preview that draws them is a preview of the machine's itinerary rather than of
the part. If travel visualisation is ever wanted it belongs in a second, separate stream
so it cannot bloat the thing the phone must load.

### Both endpoints, not a polyline

Storing only the end point plus a "restart" flag would save ~30 % — extrusions chain, so
each segment's start is usually the previous one's end. It is not done, and the reason is
what the client does with the data: it slices a layer chunk into **feature buckets** and
uploads each bucket as one draw call. A chained representation makes a bucket
undecodable without walking every preceding segment in the layer, which turns "show only
the outer walls" from a filtered copy into a full sequential decode. Self-contained
records also survive being sliced at an arbitrary record boundary, which is what a byte
range is.

## Quantisation

`mm = origin[axis] + q * scale[axis]`, with `origin` and `scale` in the index.

The grid spans **the toolpath's own bounding box**, 65 536 steps per axis. It is not the
bed: a 90 mm object on a 256 mm bed gets 1.5 µm steps instead of 3.9 µm, and models are
usually much smaller than the bed they sit on.

Is 1.5 µm enough? The line being drawn is ~420 µm wide. The quantisation error is a third
of a percent of the width of the thing it is quantising, on a screen where that line is a
few pixels across. `float32` would be exact to ~0.01 µm and cost 12 bytes per record
instead of 6 — a 33 % larger format to represent detail no display can show and no
printer can print.

Two consequences are worth stating because they show up in the code:

- A degenerate axis (a single-layer print has zero Z extent) gets `scale = 0`. Dequantising
  then returns `origin`, which is right, and nothing divides by zero.
- Encoding **clamps** rather than wrapping. Points always fall inside a box measured from
  the same toolpath, so this cannot fire — but a `uint16` that wrapped would put a segment
  on the far side of the bed, and a clamp is a visible smear rather than an invisible lie.

### Why the compiler reads the file twice

The grid needs the bounding box, and the bounding box needs the last move. The
alternatives were all worse:

| option                                           | why not                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| buffer every segment until the box is known      | 26 MiB plus object overhead on the server — the exact failure this milestone exists to avoid, moved upstream |
| 32-byte absolute-micrometre records, one pass    | 78 % more bytes, forever, on every layer the phone loads                                                     |
| take the grid from the header's `printable_area` | one pass and exact, but wrong for a custom bed and it spends resolution on the empty parts of the bed        |

So pass one measures and pass two encodes. The second read comes out of the page cache,
the whole thing happens once per job ever, and peak RSS stays at one layer plus the read
buffer. Measured: 2.7 s and 150 MB peak for 42 MiB of G-code.

## Feature types

`feature` is a byte, and the values are **frozen** — they are in the binary and the
client's colour table reads them. Append, never renumber.

|   # | name                  |     |   # | name               |
| --: | --------------------- | --- | --: | ------------------ |
|   0 | Unknown               |     |  10 | Internal Bridge    |
|   1 | Custom                |     |  11 | Gap infill         |
|   2 | Outer wall            |     |  12 | Ironing            |
|   3 | Inner wall            |     |  13 | Skirt              |
|   4 | Overhang wall         |     |  14 | Brim               |
|   5 | Sparse infill         |     |  15 | Support            |
|   6 | Internal solid infill |     |  16 | Support interface  |
|   7 | Top surface           |     |  17 | Support transition |
|   8 | Bottom surface        |     |  18 | Prime tower        |
|   9 | Bridge                |     |  19 | Mixed              |

`index.features` mirrors this table so a client need not hard-code it.

### The marker set our binary actually emits

SPEC's M5 brief says feature type comes from `;TYPE:` comments and layer boundaries from
`;LAYER_CHANGE` / `;Z:`. **OrcaSlicer 2.4.2 emits none of those.** Measured against the
pinned binary in our own image:

```
; CHANGE_LAYER              layer boundary
; Z_HEIGHT: 0.2             print Z of the layer just opened
; LAYER_HEIGHT: 0.2         its thickness
; FEATURE: Outer wall       extrusion role, human-readable
; LINE_WIDTH: 0.393713      extrusion width for the moves that follow
; layer num/total_layer_count: 1/16
; WIPE_START / ; WIPE_END
```

— all with a leading space after the `;`. A parser written against the brief's assumption
produces one layer of untyped segments and passes every smoke test. The legacy spellings
are still accepted, and the legacy role names (`External perimeter` → Outer wall,
`Internal infill` → Sparse infill, …) map onto the same enum, so the parser is not
Orca-2.4.2-only.

The role names were taken two ways and cross-checked: observed in real slices, and read
out of the binary's own string table for the roles a small test print never reaches.

## The index

`GET /jobs/:id/preview/:plate` returns it as JSON. 22.5 KiB for the 900-layer budget file.

```jsonc
{
  "format": "orca-web.gcode-preview",
  "version": 1,
  "endianness": "little",
  "segmentBytes": 18,

  "source": {
    "gcode": "plate_1.gcode",
    "plate": 1,
    "bytes": 27267516,          // length of the .bin
    "firstObjectLayer": 1,      // see below
    "headerLayerCount": 899,    // `; total layer number:`, a cross-check
    "nozzleDiameter": 0.4,      // fallback when `width` is 0
    "filamentColours": ["#F2754E"]   // per tool slot, in tool order
  },

  "quantisation": { "origin": [45, 4, 0.2], "scale": [0.00274, 0.00261, 0.00137] },
  "bounds": { "min": [45, 4, 0.2], "max": [225, 175.44, 90] },
  "features": ["Unknown", "Custom", "Outer wall", "..."],
  "tools": 1,

  "stats": { "layers": 900, "segments": 1514862, "bytes": 27267516,
             "arcs": 7848, "arcSegments": 13505, "arcsUnsupportedPlane": 0,
             "segmentsWithoutFeature": 0, "unparsedLines": 0, "parseMs": 2710 },

  "layers": {
    "z":           [0.3, 0.2, 0.3, ...],   // mm, print order
    "height":      [0,   0.2, 0.1, ...],   // mm, 0 = unknown
    "count":       [105, 584, 658, ...],   // segments
    "offset":      [0,   1890, 12402, ...],// bytes into the .bin
    "featureMask": [2,   1548, 1580, ...]  // bit (1 << feature) per feature present
  }
}
```

**Parallel arrays, not an array of objects.** 900 layers cost ~22 KB this way and about
three times that as objects, and the client wants columns anyway: it binary-searches `z`
and sums `count`.

**`offset` is stored, not derived.** It is a prefix sum of `count * 18` and could be
recomputed, but 900 numbers is 6 KB and the alternative is every client reimplementing
the one arithmetic step that silently produces a corrupt window when it is wrong.

**`featureMask`** lets a filtered view ("show only supports") skip whole layers without
fetching them.

**`firstObjectLayer`** is the one wart, and it is the machine's fault rather than the
format's. MEASURED: a Bambu profile's start G-code prints a **585 mm prime line at Z 0.3**
— above the object's first layer at Z 0.2 — before the first `; CHANGE_LAYER`. It is real
deposited material and it is in the file, so it is layer 0; but its Z does not sort, and a
layer slider should start at `firstObjectLayer`. `layers.z` is monotonic from there on.
When the machine prints no prime line, layer 0 is dropped and `firstObjectLayer` is 0.

**`stats` is not decoration.** `unparsedLines` and `segmentsWithoutFeature` are how "the
parser quietly ignored a third of the file" becomes a number in a JSON response instead
of a discovery in the browser. Both are 0 on every slice measured so far.

## Fetching a layer window

```js
const index = await (await fetch(`/jobs/${jobId}/preview/1`)).json();

const first = 120,
  last = 139; // the visible window
const offset = index.layers.offset[first];
const end = index.layers.offset[last] + index.layers.count[last] * index.segmentBytes - 1;

const res = await fetch(`/jobs/${jobId}/preview/1/data`, {
  headers: { Range: `bytes=${offset}-${end}` }, // -> 206 Partial Content
});
const buf = await res.arrayBuffer();

// Split the window back into layers: chunks are contiguous and in order.
let cursor = 0;
for (let layer = first; layer <= last; layer++) {
  const count = index.layers.count[layer];
  const u16 = new Uint16Array(buf, cursor * 18, count * 9);
  const u8 = new Uint8Array(buf, cursor * 18, count * 18);
  // ... build geometry for this layer, one draw call per feature bucket
  cursor += count;
}
```

`layerRange(index, first, last)` in `@orca-web/gcode` does the offset arithmetic if the
client would rather import it than repeat it.

## Caching

A job's G-code is immutable, so its preview is too. Both endpoints send a strong `ETag`
and `Cache-Control: public, max-age=31536000, immutable`. `immutable` is correct here and
deliberately _not_ used for `/catalog`: a catalog URL carries no version and must be able
to lose to a rebuilt image, whereas a job id names one slice for as long as the job
exists. Without it Safari revalidates on every reload, which is the difference between a
layer slider that scrubs and one that stutters.

The `ETag` is a digest of the index — which records the byte count, the per-layer counts
and the quantisation of the `.bin` it describes — rather than of 26 MB of binary. The
compiler is deterministic and the source is immutable, so it identifies the payload just
as precisely, at a thousandth of the cost. `PREVIEW_VERSION` is part of it, so bumping the
format invalidates every cached parse in every browser without a migration or a sweep.
`If-Range` is honoured, so a client cannot stitch bytes from two different parses together
across such a bump.

## Measurements

OrcaSlicer 2.4.2, four cores, Node 22. A 90 mm solid box at 0.1 mm layers and 25 % infill
— the shape chosen because it reaches the budget size honestly rather than by being
pathological.

|                                           |                                                 |
| ----------------------------------------- | ----------------------------------------------- |
| input G-code                              | 44 154 646 B (42.1 MiB), 1 578 132 lines        |
| parse wall clock                          | **2.7–3.1 s** over three runs (both passes)     |
| peak RSS                                  | **150–158 MB**                                  |
| `.bin`                                    | 27 267 516 B (26.0 MiB) — **0.618 ×** the input |
| index JSON                                | 23 094 B (22.6 KiB)                             |
| layers                                    | 900 (899 object + 1 prime line)                 |
| segments                                  | 1 514 862                                       |
| arcs flattened                            | 7 848 → 13 505 segments                         |
| mean bytes per layer                      | **30 297**                                      |
| quantisation step                         | 2.75 / 2.62 / 1.37 µm                           |
| `unparsedLines`, `segmentsWithoutFeature` | 0, 0                                            |

The number that answers the budget: **a 20-layer window is ~600 KB.** A phone can hold
thirty of those and still not have touched the 26 MB the model actually is.

## Arcs

Orca's arc fitting turns a share of extrusions into `G2`/`G3` (SPEC deviation #4).
Measured: 862 arcs against 2 900 linear extrusions in a curved-wall test slice — a quarter
of the toolpath, and on a cylinder it is the entire outside of the part.

They are flattened at parse time into ordinary straight segments, to a **0.02 mm chord
tolerance** (`r(1 − cos θ) ≤ tolerance`), capped at 256 chords per arc so a degenerate arc
cannot produce unbounded output. The client therefore never learns arcs exist: one
primitive, one code path. Flattening on the GPU instead would mean a second vertex format
and a second shader to save a few hundred kilobytes — the wrong trade on a phone.

`I`/`J` is what 2.4.2 emits (zero `R`-form arcs across every slice taken while building
this); `R` is implemented anyway because it is standard G-code. `G18`/`G19` — arcs in the
XZ/YZ plane — are drawn as their chord and counted in `stats.arcsUnsupportedPlane`, which
is 0 on everything measured. A `G2`/`G3` whose endpoint is omitted is a **full circle**,
not a no-op; 2.4.2's machine start G-code contains bare `G2 I0.5 J0 F300` nozzle-wipe
circles.

## What this format deliberately does not carry

- **Time and material.** SPEC is explicit: those come from `slice_info.config`, which M1
  already parses. Nothing here recomputes them.
- **Feedrate, acceleration, per-segment E.** A colour-by-speed view would want the first;
  it is not in the budget, and adding a `uint16` for it later is a version bump, not a
  redesign.
- **Travels.** See above.
