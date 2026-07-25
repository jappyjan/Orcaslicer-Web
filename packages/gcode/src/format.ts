/**
 * The wire format of the G-code preview. Byte layout, quantisation and index shape.
 *
 * Full rationale — and the "load a layer window on a 4 GB phone" argument that drives
 * every choice here — is in docs/GCODE-PREVIEW-FORMAT.md. This file is the normative
 * definition; the document explains it.
 *
 * Two artefacts per plate:
 *
 *   plate_N.preview.json   the index (this file's `PreviewIndex`)
 *   plate_N.preview.bin    layer chunks, back to back, in layer order
 *
 * A layer chunk is `count` fixed-size records with no header, so a client turns a byte
 * range straight into typed-array views and never parses anything.
 */

/** Magic string in the index, so a stray JSON file cannot be mistaken for one. */
export const PREVIEW_FORMAT = 'orca-web.gcode-preview' as const;

/**
 * Bumped whenever the byte layout or the semantics of a field change. It is part of the
 * ETag, so an API upgrade invalidates every cached parse without a manual sweep.
 */
export const PREVIEW_VERSION = 1 as const;

/**
 * One extrusion segment, 18 bytes, little-endian.
 *
 *   off  type    field
 *     0  uint16  x0    quantised
 *     2  uint16  y0
 *     4  uint16  z0
 *     6  uint16  x1
 *     8  uint16  y1
 *    10  uint16  z1
 *    12  uint16  width   micrometres, 0 = unknown
 *    14  uint16  height  micrometres, 0 = unknown
 *    16  uint8   feature see `FeatureType`
 *    17  uint8   tool    0-based extruder index
 *
 * 18 is even, so the six positions plus width and height are one `Uint16Array` with a
 * stride of 9 and `feature`/`tool` are one `Uint8Array` with a stride of 18. No
 * `DataView`, no per-record object, no copy.
 */
export const SEGMENT_BYTES = 18;

/** Field offsets within a record, in `Uint16Array` elements. */
export const U16 = {
  x0: 0,
  y0: 1,
  z0: 2,
  x1: 3,
  y1: 4,
  z1: 5,
  width: 6,
  height: 7,
} as const;
/** Stride of a record in `Uint16Array` elements. */
export const U16_STRIDE = SEGMENT_BYTES / 2;

/** Field offsets within a record, in bytes, for the `Uint8Array` view. */
export const U8 = { feature: 16, tool: 17 } as const;

/** The largest quantised coordinate. Positions are `uint16`, so the grid is 65 536 wide. */
export const QUANT_MAX = 0xffff;

/**
 * Feature types, as a stable numeric enum.
 *
 * MEASURED against the pinned 2.4.2 binary: the marker is `; FEATURE: <name>` — with a
 * leading space and an upper-case word — NOT the `;TYPE:` form that PrusaSlicer and
 * older Orca releases emit. Both spellings are accepted (see `features.ts`); the names
 * below are the ones 2.4.2 actually writes, cross-checked against the display strings in
 * the binary's own string table.
 *
 * Values are frozen: they are stored in the binary and read by the client's colour
 * table. Append, never renumber.
 */
export const FeatureType = {
  Unknown: 0,
  Custom: 1,
  OuterWall: 2,
  InnerWall: 3,
  OverhangWall: 4,
  SparseInfill: 5,
  InternalSolidInfill: 6,
  TopSurface: 7,
  BottomSurface: 8,
  Bridge: 9,
  InternalBridge: 10,
  GapInfill: 11,
  Ironing: 12,
  Skirt: 13,
  Brim: 14,
  Support: 15,
  SupportInterface: 16,
  SupportTransition: 17,
  PrimeTower: 18,
  Mixed: 19,
} as const;

export type FeatureTypeValue = (typeof FeatureType)[keyof typeof FeatureType];

/** Display names, indexed by `FeatureType`. Mirrored into the index as `features`. */
export const FEATURE_NAMES: readonly string[] = [
  'Unknown',
  'Custom',
  'Outer wall',
  'Inner wall',
  'Overhang wall',
  'Sparse infill',
  'Internal solid infill',
  'Top surface',
  'Bottom surface',
  'Bridge',
  'Internal Bridge',
  'Gap infill',
  'Ironing',
  'Skirt',
  'Brim',
  'Support',
  'Support interface',
  'Support transition',
  'Prime tower',
  'Mixed',
];

/**
 * How a quantised coordinate becomes millimetres: `mm = origin[axis] + q * scale[axis]`.
 *
 * The grid spans the toolpath's own bounding box rather than the bed, so precision
 * adapts to the model: a 90 mm object quantises to 1.4 µm, a full 256 mm bed to 3.9 µm.
 * Either is an order of magnitude below the ~0.42 mm width of the line being drawn.
 */
export interface Quantisation {
  /** Millimetres. */
  origin: [number, number, number];
  /** Millimetres per quantisation step. */
  scale: [number, number, number];
}

/**
 * Per-layer index.
 *
 * Parallel arrays, not an array of objects: 900 layers cost ~25 KB of JSON this way and
 * three times that as objects, and the client wants columns anyway (it binary-searches
 * `z` and sums `count`).
 */
export interface LayerIndex {
  /**
   * Print Z of each layer, millimetres, in print order.
   *
   * Monotonically increasing from `source.firstObjectLayer` onwards. Layer 0 can sit
   * above layer 1 when it is a priming pass — see `PreviewSource.firstObjectLayer`.
   */
  z: number[];
  /** Layer height, millimetres, from `; LAYER_HEIGHT:`. 0 when the slicer did not say. */
  height: number[];
  /** Segments in the layer. Byte length is `count * SEGMENT_BYTES`. */
  count: number[];
  /** Byte offset of the layer's chunk in the `.bin`. Explicit, so no prefix sum. */
  offset: number[];
  /** Bitmask of the `FeatureType`s present, so a filtered view can skip whole layers. */
  featureMask: number[];
}

export interface PreviewBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Facts about the slice that the renderer wants and cannot get from the toolpath. */
export interface PreviewSource {
  /** Artefact name of the G-code this was compiled from. */
  gcode: string;
  /** 1-based plate. */
  plate: number;
  bytes: number;
  /**
   * Index of the first layer belonging to the object.
   *
   * MEASURED: the machine start G-code of a Bambu profile prints a 585 mm prime line at
   * Z 0.3 — above the object's first layer at Z 0.2 — before the first `; CHANGE_LAYER`.
   * It is deposited material and it is in the file, but it is not layer 1 of the model
   * and its Z does not sort. When this is 1, layer 0 is that priming pass and a layer
   * slider should start at 1; when it is 0 there was none.
   */
  firstObjectLayer: number;
  /** `; total layer number:` from the G-code header, for cross-checking `layers.z`. */
  headerLayerCount: number | null;
  nozzleDiameter: number | null;
  /** `filament_colour` from the config block, one `#RRGGBB` per tool slot. */
  filamentColours: string[];
}

/** Counts worth reporting, and the ones that prove the awkward cases were handled. */
export interface PreviewStats {
  layers: number;
  segments: number;
  /** Bytes in the `.bin`. */
  bytes: number;
  /** `G2`/`G3` moves that extruded and were interpolated into straight segments. */
  arcs: number;
  /** Segments those arcs produced. */
  arcSegments: number;
  /** Arcs in a plane other than XY (`G18`/`G19`), drawn as their chord. Expected 0. */
  arcsUnsupportedPlane: number;
  /** Extruding moves whose feature type was never announced by a marker. */
  segmentsWithoutFeature: number;
  /** Lines the tokeniser could not make sense of. Expected 0; a non-zero value is a bug. */
  unparsedLines: number;
  /** Wall-clock milliseconds spent parsing. */
  parseMs: number;
}

/** `GET /jobs/:id/preview/:plate` — everything needed to range-request layer data. */
export interface PreviewIndex {
  format: typeof PREVIEW_FORMAT;
  version: typeof PREVIEW_VERSION;
  endianness: 'little';
  segmentBytes: typeof SEGMENT_BYTES;
  source: PreviewSource;
  quantisation: Quantisation;
  /** Toolpath bounding box in millimetres. */
  bounds: PreviewBounds;
  /** Display names indexed by the record's `feature` byte. */
  features: readonly string[];
  /** Highest tool index seen, plus one. */
  tools: number;
  stats: PreviewStats;
  layers: LayerIndex;
}

/** `mm = origin + q * scale`, for a client that would rather not reimplement it. */
export function dequantise(q: Quantisation, axis: 0 | 1 | 2, value: number): number {
  return q.origin[axis] + value * q.scale[axis];
}

/**
 * Byte range covering layers `[first, last]` inclusive — the one computation a client
 * has to get right, so it lives here rather than in a comment.
 */
export function layerRange(
  index: PreviewIndex,
  first: number,
  last: number,
): { offset: number; length: number } | undefined {
  const { offset, count } = index.layers;
  const lo = Math.max(0, Math.min(first, last));
  const hi = Math.min(offset.length - 1, Math.max(first, last));
  if (lo > hi || offset.length === 0) return undefined;
  const start = offset[lo] as number;
  const end = (offset[hi] as number) + (count[hi] as number) * SEGMENT_BYTES;
  return { offset: start, length: end - start };
}
