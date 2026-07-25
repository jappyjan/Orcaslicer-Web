/**
 * The arithmetic that decides what a phone holds.
 *
 * Every case here is one of the ways the preview can look plausible and be wrong: a window
 * that quietly exceeds the memory budget, a byte range that is one record short, a refetch
 * of layers already on the GPU, or a slider that starts on the machine's prime line.
 */

import { describe, expect, it } from 'vitest';
import type { PreviewIndex } from '@orca-web/gcode';
import {
  MAX_WINDOW_BYTES,
  MAX_WINDOW_SEGMENTS,
  byteRange,
  evictable,
  featureColour,
  firstLayer,
  lastLayer,
  layerLabel,
  legendFor,
  missingRuns,
  parseHexColour,
  toolColours,
  windowFor,
  windowSegments,
} from './preview.ts';

/** An index shaped like the real one: parallel arrays, prefix-summed offsets. */
function makeIndex(counts: number[], options: Partial<PreviewIndex['source']> = {}): PreviewIndex {
  const offset: number[] = [];
  let running = 0;
  for (const count of counts) {
    offset.push(running);
    running += count * 18;
  }
  return {
    format: 'orca-web.gcode-preview',
    version: 1,
    endianness: 'little',
    segmentBytes: 18,
    source: {
      gcode: 'plate_1.gcode',
      plate: 1,
      bytes: running,
      firstObjectLayer: 1,
      headerLayerCount: counts.length - 1,
      nozzleDiameter: 0.4,
      filamentColours: ['#F2754E'],
      ...options,
    },
    quantisation: { origin: [0, 0, 0], scale: [1, 1, 1] },
    bounds: { min: [0, 0, 0], max: [100, 100, 10] },
    features: ['Unknown', 'Custom', 'Outer wall', 'Inner wall', 'Overhang wall', 'Sparse infill'],
    tools: 1,
    stats: {
      layers: counts.length,
      segments: counts.reduce((a, b) => a + b, 0),
      bytes: running,
      arcs: 0,
      arcSegments: 0,
      arcsUnsupportedPlane: 0,
      segmentsWithoutFeature: 0,
      unparsedLines: 0,
      parseMs: 1,
    },
    layers: {
      z: counts.map((_, layer) => (layer === 0 ? 0.3 : 0.2 + (layer - 1) * 0.2)),
      height: counts.map(() => 0.2),
      count: counts,
      offset,
      featureMask: counts.map((_, layer) => (layer === 0 ? 1 << 1 : (1 << 2) | (1 << 5))),
    },
  };
}

describe('firstLayer / lastLayer', () => {
  it('starts the slider above the prime line', () => {
    // MEASURED: layer 0 is a 585 mm prime line at Z 0.3, above the object's first layer at
    // Z 0.2. Its Z does not sort, so a slider that started there would step backwards.
    const index = makeIndex([105, 900, 900]);
    expect(firstLayer(index)).toBe(1);
    expect(index.layers.z[0]).toBeGreaterThan(index.layers.z[1] as number);
    expect(lastLayer(index)).toBe(2);
  });

  it('starts at layer 0 when the machine printed no prime line', () => {
    expect(firstLayer(makeIndex([900, 900], { firstObjectLayer: 0 }))).toBe(0);
  });
});

describe('windowFor', () => {
  it('takes the requested depth, ending at the layer asked for', () => {
    const index = makeIndex(Array.from({ length: 100 }, () => 100));
    expect(windowFor(index, 50, 20)).toEqual({ first: 31, last: 50 });
  });

  it('never returns a layer above the one the user is pointing at', () => {
    const index = makeIndex(Array.from({ length: 100 }, () => 100));
    expect(windowFor(index, 5, 20).last).toBe(5);
  });

  it('includes the prime line only when the window reaches the bottom of the print', () => {
    const index = makeIndex(Array.from({ length: 100 }, () => 100));
    expect(windowFor(index, 10, 20).first).toBe(0);
    expect(windowFor(index, 40, 20).first).toBe(21);
  });

  it('clamps to the top and bottom of the model', () => {
    const index = makeIndex(Array.from({ length: 10 }, () => 100));
    expect(windowFor(index, 999, 5)).toEqual({ first: 5, last: 9 });
    expect(windowFor(index, -5, 5).last).toBe(1);
  });

  it('drops the oldest layers rather than exceed the segment budget', () => {
    // 60 000 segments a layer: five layers is already a quarter of a million.
    const index = makeIndex(Array.from({ length: 50 }, () => 60_000));
    const window = windowFor(index, 40, 20);
    expect(window.last).toBe(40);
    expect(windowSegments(index, window)).toBeLessThanOrEqual(MAX_WINDOW_SEGMENTS);
    expect(window.first).toBeGreaterThan(21);
  });

  it('drops the oldest layers rather than exceed the byte budget', () => {
    const index = makeIndex(Array.from({ length: 400 }, () => 8000));
    const window = windowFor(index, 300, 200);
    expect(byteRange(index, window)?.length ?? 0).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
  });

  it('always keeps at least the layer being pointed at', () => {
    const index = makeIndex(Array.from({ length: 5 }, () => 5_000_000));
    expect(windowFor(index, 3, 20)).toEqual({ first: 3, last: 3 });
  });
});

describe('byteRange', () => {
  it('is inclusive at both ends, as a Range header is', () => {
    const index = makeIndex([10, 20, 30, 40]);
    // Layers 1..2: offsets 180 and 540, so 20 + 30 records = 900 bytes ending at 1079.
    expect(byteRange(index, { first: 1, last: 2 })).toEqual({
      start: 180,
      end: 1079,
      length: 900,
    });
  });

  it('covers the whole file for the whole range', () => {
    const index = makeIndex([10, 20, 30]);
    const range = byteRange(index, { first: 0, last: 2 });
    expect(range).toEqual({ start: 0, end: index.source.bytes - 1, length: index.source.bytes });
  });

  it('refuses an inverted range instead of producing a negative length', () => {
    expect(byteRange(makeIndex([10, 10]), { first: 1, last: 0 })).toBeNull();
  });
});

describe('missingRuns', () => {
  it('asks for nothing when everything is already loaded', () => {
    expect(missingRuns({ first: 4, last: 6 }, new Set([4, 5, 6]))).toEqual([]);
  });

  it('turns a one-layer scroll into a one-layer request', () => {
    // The whole reason the slider scrubs: shifting the window by one must not refetch it.
    expect(missingRuns({ first: 11, last: 30 }, new Set(range(10, 29)))).toEqual([
      { first: 30, last: 30 },
    ]);
  });

  it('coalesces a gap into contiguous runs, one request each', () => {
    expect(missingRuns({ first: 0, last: 6 }, new Set([2, 3]))).toEqual([
      { first: 0, last: 1 },
      { first: 4, last: 6 },
    ]);
  });

  it('asks for the whole window after a jump across the model', () => {
    expect(missingRuns({ first: 500, last: 502 }, new Set([1, 2, 3]))).toEqual([
      { first: 500, last: 502 },
    ]);
  });
});

describe('evictable', () => {
  it('releases exactly what fell outside the window', () => {
    expect(evictable({ first: 5, last: 7 }, [3, 4, 5, 6, 7, 8]).sort((a, b) => a - b)).toEqual([
      3, 4, 8,
    ]);
  });
});

describe('colours', () => {
  it('reads the slice’s own filament colours for colour-by-tool', () => {
    const index = makeIndex([10], { filamentColours: ['#F2754E', '#0000FF'] });
    expect(toolColours(index)).toEqual([0xf2754e, 0x0000ff]);
  });

  it('falls back for a slot the config never named', () => {
    const index = makeIndex([10], { filamentColours: [] });
    expect(toolColours(index)).toHaveLength(1);
    expect(toolColours(index)[0]).toBeTypeOf('number');
  });

  it('rejects anything that is not a six-digit hex colour', () => {
    expect(parseHexColour('#abc')).toBeUndefined();
    expect(parseHexColour('red')).toBeUndefined();
    expect(parseHexColour(undefined)).toBeUndefined();
    expect(parseHexColour('123456')).toBe(0x123456);
  });

  it('gives an unknown feature byte a colour rather than undefined', () => {
    expect(featureColour(250)).toBe(featureColour(0));
  });
});

describe('legendFor', () => {
  it('is built from featureMask alone, so it is right before any data arrives', () => {
    const index = makeIndex([105, 900, 900]);
    expect(legendFor(index, { first: 1, last: 2 }).map((entry) => entry.name)).toEqual([
      'Outer wall',
      'Sparse infill',
    ]);
    expect(legendFor(index, { first: 0, last: 0 }).map((entry) => entry.name)).toEqual(['Custom']);
  });
});

describe('layerLabel', () => {
  it('numbers layers from the first object layer, not from the prime line', () => {
    const index = makeIndex([105, 900, 900, 900]);
    expect(layerLabel(index, 1)).toBe('Layer 1 of 3 · Z 0.20 mm');
    expect(layerLabel(index, 3)).toBe('Layer 3 of 3 · Z 0.60 mm');
  });
});

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
