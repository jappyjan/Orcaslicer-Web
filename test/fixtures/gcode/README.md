# Real OrcaSlicer 2.4.2 output, for the M5 preview parser

These are **unmodified, complete** G-code files produced by the pinned binary inside our
own image. They are gzipped only because the repository should not carry a quarter of a
megabyte of plain text; nothing else about them is edited. A parser regression test
written against G-code that the author typed by hand proves only that the parser agrees
with its author, which is precisely the failure SPEC's verified deviation #4 describes.

They are read by `packages/gcode/src/real-output.test.ts`.

## `orca-2.4.2-arcs-features.gcode.gz`

Everything the parser has to survive in one 15-layer slice:

| what | measured in this file |
| --- | --- |
| `G2`/`G3` arcs from Orca's arc fitting (deviation #4) | 862, of which 838 extrude |
| `E` values with no leading digit — `E.02345` (deviation #4) | 3 764 of 4 028 `E` words |
| `; FEATURE:` roles — **not** `;TYPE:` | 11 distinct, incl. Bridge, Overhang wall, Support interface, Gap infill |
| `; CHANGE_LAYER` / `; Z_HEIGHT:` / `; LAYER_HEIGHT:` / `; LINE_WIDTH:` | 15 layers |
| Bambu `T1000` / `T1100` / `T255` pseudo-tools | 4 — none of them a tool change |
| relative extrusion (`M83`) | yes |

Produced with:

```
model    tube r8/r5.5 h2 (48 segments) + a 15 mm slab bridging it at z = 3.2
printer  BBL / Bambu Lab X1 Carbon 0.4 nozzle
process  BBL / 0.28mm Extra Draft @BBL X1C
filament BBL / Bambu PLA Basic @BBL X1C
flags    --enable-support --enable-overhang-speed
```

## `orca-2.4.2-absolute-e.gcode.gz`

The other extruder-addressing mode, which the Bambu profiles never take. A 20 × 20 ×
1.2 mm slab sliced with `--use-relative-e-distances=0`: `M82`, a monotonically rising `E`
odometer, and 23 `G92 E` resets. SPEC's gotcha list calls the `G92 E0` reset out
explicitly, so it gets real output rather than a hand-written approximation.

Note the flag spelling: `--use-relative-e-distances 0` is rejected (`No such file: 0` —
the `0` is taken as a positional model path). Boolean `PrintConfig` keys are switches on
this CLI and need the `=` form to be set false.
