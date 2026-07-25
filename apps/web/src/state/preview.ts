/**
 * The G-code preview's arithmetic, with no three.js and no DOM in it.
 *
 * Everything here answers one of three questions, and all three are easy to get subtly
 * wrong in a way that shows up as a picture that looks plausible and is not:
 *
 *  1. **Which layers am I allowed to hold?** SPEC's M5 budget is a 40 MB G-code file on a
 *     4 GB phone, so the window is capped by *bytes and segments*, not by a layer count —
 *     a 200-layer window of a skirt is nothing and a 200-layer window of dense infill is
 *     40 MB of GPU buffers.
 *  2. **Which bytes do I still have to fetch?** Windows shift by a layer or two while the
 *     slider is dragged, so the answer is almost always a short contiguous run at one end,
 *     and refetching the whole window per frame is the difference between a slider that
 *     scrubs and one that stutters.
 *  3. **What colour is this segment?** By feature type and by tool, both, as the brief
 *     asks — with the tool palette coming from the slice's own `filament_colour`.
 *
 * Kept free of three.js on purpose: the renderer is in a lazily loaded chunk, and this is
 * the part with the edge cases worth unit-testing.
 */

import type { PreviewIndex } from '@orca-web/gcode';

/**
 * Segments a window may hold.
 *
 * Each one costs 64 B of instance matrix + 12 B of instance colour in JS, and the same
 * again in a GPU buffer — call it 160 B all-in. 240 000 is therefore ~38 MB of the phone's
 * memory for the deepest window the UI can ask for, against a whole model that would be
 * 1.5 M segments and 240 MB. The default window is a tenth of this.
 */
export const MAX_WINDOW_SEGMENTS = 240_000;

/**
 * Bytes a window may fetch in one go. The measured mean is ~30 KB per layer, so this is
 * ~270 layers of a typical model and rather fewer of a pathological one.
 */
export const MAX_WINDOW_BYTES = 8 * 1024 * 1024;

/** Layers shown by default. ~600 KB and ~33 000 segments on the budget file. */
export const DEFAULT_WINDOW_LAYERS = 20;

/** Ceiling on the "layers shown" control, before the byte and segment caps bite. */
export const MAX_WINDOW_LAYERS = 200;

export type ColourMode = 'feature' | 'tool';

/** Inclusive layer range. */
export interface LayerWindow {
  first: number;
  last: number;
}

/**
 * Feature colours, indexed by the record's `feature` byte.
 *
 * The order is `FeatureType` in `@orca-web/gcode`, which is frozen — the values are in the
 * binary. Hues are chosen to stay distinguishable on a phone screen in daylight rather
 * than to match OrcaSlicer's desktop palette exactly; walls, infill and support are the
 * three groups a user is actually looking for, so they are orange, red/violet and teal.
 */
export const FEATURE_COLOURS: readonly number[] = [
  0x8d99ae, // Unknown
  0xc084fc, // Custom
  0xf97316, // Outer wall
  0xfbbf24, // Inner wall
  0x38bdf8, // Overhang wall
  0xef4444, // Sparse infill
  0xa855f7, // Internal solid infill
  0xec4899, // Top surface
  0x22d3ee, // Bottom surface
  0x2563eb, // Bridge
  0x60a5fa, // Internal bridge
  0xfde047, // Gap infill
  0xf472b6, // Ironing
  0x94a3b8, // Skirt
  0xcbd5e1, // Brim
  0x14b8a6, // Support
  0x5eead4, // Support interface
  0x99f6e4, // Support transition
  0xeab308, // Prime tower
  0xfda4af, // Mixed
];

/**
 * Fallback tool colours.
 *
 * `source.filamentColours` is the real answer and comes from the slice's own
 * `filament_colour`; this only covers a slot the config never named. VERIFIED DEVIATION
 * #24: no genuinely multi-tool slice exists to test against yet, so anything past slot 1
 * is exercised only by the pseudo-tools of deviation #21.
 */
export const TOOL_FALLBACK_COLOURS: readonly number[] = [
  0x38bdf8, 0xf97316, 0x22c55e, 0xec4899, 0xfacc15, 0xa855f7, 0x14b8a6, 0xf87171,
];

export function featureColour(feature: number): number {
  return FEATURE_COLOURS[feature] ?? (FEATURE_COLOURS[0] as number);
}

/** `#RRGGBB` → `0xRRGGBB`, or `undefined` for anything that is not one. */
export function parseHexColour(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? Number.parseInt(match[1] as string, 16) : undefined;
}

/** The palette for colour-by-tool: the slice's own filament colours, then fallbacks. */
export function toolColours(index: PreviewIndex): number[] {
  const slots = Math.max(1, index.tools, index.source.filamentColours.length);
  const out: number[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    out.push(
      parseHexColour(index.source.filamentColours[slot]) ??
        (TOOL_FALLBACK_COLOURS[slot % TOOL_FALLBACK_COLOURS.length] as number),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The layer window
// ---------------------------------------------------------------------------

export function layerCount(index: PreviewIndex): number {
  return index.layers.z.length;
}

/**
 * The lowest layer the slider may reach.
 *
 * MEASURED (docs/GCODE-PREVIEW-FORMAT.md): layer 0 can be the machine's 585 mm prime line
 * at a Z *above* layer 1, so it does not sort and a slider that started there would jump
 * backwards on its first step. `layers.z` is monotonic from `firstObjectLayer` on.
 */
export function firstLayer(index: PreviewIndex): number {
  return Math.min(Math.max(0, index.source.firstObjectLayer), Math.max(0, layerCount(index) - 1));
}

export function lastLayer(index: PreviewIndex): number {
  return Math.max(0, layerCount(index) - 1);
}

/**
 * The window ending at `top` and `depth` layers deep, clamped to what a phone may hold.
 *
 * Clamped from the *bottom* up: the top layer is the one the user is looking at and must
 * never be dropped, so a window that would exceed the budget loses its oldest layers
 * rather than its newest.
 *
 * The prime-line layer is included when the window reaches the bottom of the print — it is
 * real deposited material, it is contiguous with layer 1 in the `.bin`, and it costs about
 * two kilobytes. It is deliberately *not* reachable on its own, for the sorting reason
 * above.
 */
export function windowFor(index: PreviewIndex, top: number, depth: number): LayerWindow {
  const bottom = firstLayer(index);
  const ceiling = lastLayer(index);
  const last = Math.min(ceiling, Math.max(bottom, Math.round(top)));
  const wanted = Math.max(1, Math.min(MAX_WINDOW_LAYERS, Math.round(depth)));
  let first = Math.max(bottom, last - wanted + 1);
  if (first === bottom && bottom > 0) first = 0;

  // Walk down from the top, stopping at whichever cap bites first. Both are needed:
  // segments decide the GPU cost and bytes decide the download, and a layer of sparse
  // infill and a layer of ironing are nothing alike on either axis.
  const { count, offset } = index.layers;
  const topByte = (offset[last] as number) + (count[last] as number) * index.segmentBytes;
  let segments = 0;
  for (let layer = last; layer >= first; layer -= 1) {
    const next = segments + (count[layer] ?? 0);
    const span = topByte - (offset[layer] ?? 0);
    if (layer < last && (next > MAX_WINDOW_SEGMENTS || span > MAX_WINDOW_BYTES)) {
      return { first: layer + 1, last };
    }
    segments = next;
  }
  return { first, last };
}

/** Segments in `[first, last]`. */
export function windowSegments(index: PreviewIndex, window: LayerWindow): number {
  let total = 0;
  for (let layer = window.first; layer <= window.last; layer += 1) {
    total += index.layers.count[layer] ?? 0;
  }
  return total;
}

/**
 * Byte range of `[first, last]`, inclusive of both ends.
 *
 * This is `layerRange()` from `@orca-web/gcode` with the `Range` header's inclusive end
 * already applied. It is repeated rather than imported because the package's entry point
 * reaches `node:fs` through the compiler, and the client must not pull that into a browser
 * bundle to do six lines of arithmetic.
 */
export function byteRange(
  index: PreviewIndex,
  window: LayerWindow,
): { start: number; end: number; length: number } | null {
  const { offset, count } = index.layers;
  if (window.first > window.last) return null;
  const start = offset[window.first];
  const lastCount = count[window.last];
  const lastOffset = offset[window.last];
  if (start === undefined || lastCount === undefined || lastOffset === undefined) return null;
  const end = lastOffset + lastCount * index.segmentBytes - 1;
  return { start, end, length: end - start + 1 };
}

/**
 * The layers in `want` that are not already `have`, as contiguous runs.
 *
 * A run is one HTTP range request. Dragging the slider by a layer produces exactly one
 * one-layer run; jumping across the model produces one run covering the whole window.
 */
export function missingRuns(want: LayerWindow, have: ReadonlySet<number>): LayerWindow[] {
  const runs: LayerWindow[] = [];
  let open: LayerWindow | null = null;
  for (let layer = want.first; layer <= want.last; layer += 1) {
    if (have.has(layer)) {
      if (open) {
        runs.push(open);
        open = null;
      }
      continue;
    }
    if (open) open.last = layer;
    else open = { first: layer, last: layer };
  }
  if (open) runs.push(open);
  return runs;
}

/** Loaded layers that have fallen outside the window, so their GPU buffers can go. */
export function evictable(want: LayerWindow, have: Iterable<number>): number[] {
  const out: number[] = [];
  for (const layer of have) {
    if (layer < want.first || layer > want.last) out.push(layer);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The legend
// ---------------------------------------------------------------------------

export interface LegendEntry {
  feature: number;
  name: string;
  colour: number;
}

/**
 * Feature types present in the window, from `featureMask` alone.
 *
 * The mask is in the index, so the legend is right before a single byte of segment data
 * has arrived — which is what makes it useful while scrubbing rather than a caption that
 * lags the picture.
 */
export function legendFor(index: PreviewIndex, window: LayerWindow): LegendEntry[] {
  let mask = 0;
  for (let layer = window.first; layer <= window.last; layer += 1) {
    mask |= index.layers.featureMask[layer] ?? 0;
  }
  const out: LegendEntry[] = [];
  for (let feature = 0; feature < index.features.length; feature += 1) {
    if ((mask & (1 << feature)) === 0) continue;
    out.push({
      feature,
      name: index.features[feature] ?? `Feature ${feature}`,
      colour: featureColour(feature),
    });
  }
  return out;
}

/** "Layer 452 of 899 · Z 45.20 mm" — the label the slider needs while it is being dragged. */
export function layerLabel(index: PreviewIndex, layer: number): string {
  const z = index.layers.z[layer];
  const total = lastLayer(index);
  const bottom = firstLayer(index);
  const shown = layer - bottom + 1;
  const of = total - bottom + 1;
  return z === undefined
    ? `Layer ${shown} of ${of}`
    : `Layer ${shown} of ${of} · Z ${z.toFixed(2)} mm`;
}

/**
 * Extrusion width and height in millimetres, with the "the slicer never said" fallback.
 *
 * MEASURED: `width` and `height` are 0 for the prime line, which runs before the first
 * `; LINE_WIDTH:`. A zero-width box is invisible, so the nozzle diameter stands in — that
 * is what the machine actually deposited there, to within the accuracy of a preview.
 */
export function fallbackWidth(index: PreviewIndex): number {
  return index.source.nozzleDiameter ?? 0.4;
}

export function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
