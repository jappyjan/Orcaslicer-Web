/**
 * The regression test that matters: REAL OrcaSlicer 2.4.2 output, not G-code written to
 * match this parser.
 *
 * SPEC verified deviation #4 exists because a plausible-looking regex found 8 extrusions
 * out of 6 946. A parser tested only against its author's idea of G-code would reproduce
 * that mistake exactly, and pass. So the fixtures in `test/fixtures/gcode/` are complete,
 * unmodified slices taken from the pinned binary in our own image (provenance and
 * measured contents: `test/fixtures/gcode/README.md`), and the toolpath they describe is
 * checked against an INDEPENDENT computation written in a different style, in this file,
 * that shares no code with the parser.
 */

import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compilePreview } from './build.js';
import { decodeSegments } from './encode.js';
import {
  FEATURE_NAMES,
  FeatureType,
  SEGMENT_BYTES,
  layerRange,
  type PreviewIndex,
} from './format.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/gcode');

interface Compiled {
  index: PreviewIndex;
  bin: Buffer;
  gcode: string;
}

let scratch = '';

async function compileFixture(name: string): Promise<Compiled> {
  const gcode = gunzipSync(await readFile(join(FIXTURES, `${name}.gcode.gz`))).toString('latin1');
  const gcodePath = join(scratch, `${name}.gcode`);
  await writeFile(gcodePath, gcode, 'latin1');
  const binPath = join(scratch, `${name}.preview.bin`);
  const indexPath = join(scratch, `${name}.preview.json`);
  const index = await compilePreview({
    gcodePath,
    binPath,
    indexPath,
    plate: 1,
    gcodeName: `${name}.gcode`,
  });
  return { index, bin: await readFile(binPath), gcode };
}

/**
 * An independent reading of the same toolpath.
 *
 * Deliberately written in a different style from `parser.ts` — whitespace `split`,
 * `Number.parseFloat` on the tail of each word, exact trigonometric arc *length* instead
 * of chord flattening — so that agreeing with it means the geometry is right rather than
 * that one implementation was copied twice.
 */
function independentToolpath(gcode: string): {
  length: number;
  linearMoves: number;
  arcMoves: number;
  layers: number;
  maxZ: number;
  /** Extruding moves before the first `; CHANGE_LAYER` — the machine's prime line. */
  prologueMoves: number;
} {
  let x = 0;
  let y = 0;
  let z = 0;
  let e = 0;
  let absoluteE = true;
  let absoluteXYZ = true;
  let length = 0;
  let linearMoves = 0;
  let arcMoves = 0;
  let layers = 0;
  let maxZ = 0;
  let prologueMoves = 0;

  for (const raw of gcode.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      if (line.replace(/\s+/g, '') === ';CHANGE_LAYER') layers += 1;
      continue;
    }
    if (line === '') continue;
    const code = line.split(';')[0] as string;
    const parts = code
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '');
    const head = parts[0];
    if (head === undefined) continue;

    if (head === 'M82') absoluteE = true;
    if (head === 'M83') absoluteE = false;
    if (head === 'G90') absoluteXYZ = true;
    if (head === 'G91') absoluteXYZ = false;

    const word = (letter: string): number | undefined => {
      for (const part of parts.slice(1)) {
        if (part[0]?.toUpperCase() === letter) {
          // `E.02345` and `E-.8`: parseFloat copes; a regex on `[0-9]` would not.
          const value = Number.parseFloat(part.slice(1));
          return Number.isNaN(value) ? undefined : value;
        }
      }
      return undefined;
    };

    if (head === 'G92') {
      const ev = word('E');
      if (ev !== undefined) e = ev;
      continue;
    }

    const isLinear = head === 'G0' || head === 'G1';
    const isArc = head === 'G2' || head === 'G3';
    if (!isLinear && !isArc) continue;

    const wx = word('X');
    const wy = word('Y');
    const wz = word('Z');
    const we = word('E');
    const nx = wx === undefined ? x : absoluteXYZ ? wx : x + wx;
    const ny = wy === undefined ? y : absoluteXYZ ? wy : y + wy;
    const nz = wz === undefined ? z : absoluteXYZ ? wz : z + wz;

    let delta = 0;
    if (we !== undefined) {
      if (absoluteE) {
        delta = we - e;
        e = we;
      } else {
        delta = we;
        e += we;
      }
    }
    const extruding = head !== 'G0' && delta > 0;

    const moved = Math.hypot(nx - x, ny - y, nz - z) > 0;
    if (extruding && moved) {
      if (layers === 0) prologueMoves += 1;
      if (isArc) {
        const i = word('I') ?? 0;
        const j = word('J') ?? 0;
        const cx = x + i;
        const cy = y + j;
        const radius = Math.hypot(i, j);
        const a0 = Math.atan2(y - cy, x - cx);
        const a1 = Math.atan2(ny - cy, nx - cx);
        let sweep = head === 'G2' ? a0 - a1 : a1 - a0;
        while (sweep <= 0) sweep += Math.PI * 2;
        length += radius * sweep;
        arcMoves += 1;
      } else {
        length += Math.hypot(nx - x, ny - y, nz - z);
        linearMoves += 1;
      }
      // Only extruding moves: the end G-code parks the head at Z 104 and that is not a
      // layer.
      if (nz > maxZ) maxZ = nz;
    }

    x = nx;
    y = ny;
    z = nz;
  }

  return { length, linearMoves, arcMoves, layers, maxZ, prologueMoves };
}

function decodeAll(compiled: Compiled): ReturnType<typeof decodeSegments> {
  return decodeSegments(new Uint8Array(compiled.bin), compiled.index.quantisation);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gcode-preview-'));
});

afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('real OrcaSlicer 2.4.2 output — arcs, features, leading-dot E', () => {
  let compiled: Compiled;

  beforeAll(async () => {
    compiled = await compileFixture('orca-2.4.2-arcs-features');
  });

  it('is genuinely the shape SPEC deviation #4 describes', () => {
    // These assertions are about the FIXTURE, not the parser: if a future re-slice makes
    // them false the fixture has stopped exercising the trap and the tests below are
    // proving nothing.
    const naive = compiled.gcode.match(/^G1 .*E[0-9]/gm) ?? [];
    const leadingDot = compiled.gcode.match(/E\.[0-9]/g) ?? [];
    const arcs = compiled.gcode.match(/^G[23] /gm) ?? [];
    expect(leadingDot.length).toBeGreaterThan(3000);
    expect(arcs.length).toBeGreaterThan(800);
    // The measurement SPEC records: the obvious regex sees a rounding error's worth of
    // the toolpath.
    expect(naive.length * 20).toBeLessThan(leadingDot.length);

    // The marker set is Orca 2.4.2's, not the brief's assumed `;TYPE:` / `;LAYER_CHANGE`.
    expect(compiled.gcode).toContain('\n; FEATURE: Outer wall\n');
    expect(compiled.gcode).toContain('\n; CHANGE_LAYER\n');
    expect(compiled.gcode).toContain('\n; Z_HEIGHT: ');
    expect(compiled.gcode).not.toContain('\n;TYPE:');
    expect(compiled.gcode).not.toContain('\n;LAYER_CHANGE');
  });

  it('parses every line it sees', () => {
    expect(compiled.index.stats.unparsedLines).toBe(0);
    expect(compiled.index.stats.arcsUnsupportedPlane).toBe(0);
  });

  it('flattens the arcs instead of dropping them', () => {
    const independent = independentToolpath(compiled.gcode);
    expect(compiled.index.stats.arcs).toBe(independent.arcMoves);
    expect(compiled.index.stats.arcs).toBeGreaterThan(800);
    // Every arc becomes more than one straight segment, or it was not flattened at all.
    expect(compiled.index.stats.arcSegments).toBeGreaterThan(compiled.index.stats.arcs * 2);
  });

  it('reproduces the toolpath: total extruded length matches an independent computation', () => {
    const independent = independentToolpath(compiled.gcode);
    const segments = decodeAll(compiled);
    const length = segments.reduce(
      (sum, s) => sum + Math.hypot(s.x1 - s.x0, s.y1 - s.y0, s.z1 - s.z0),
      0,
    );

    // Chords are marginally shorter than the arcs they replace (sin θ / θ), and
    // positions are quantised to ~0.35 µm here, so exact equality is not the claim.
    // A quarter of this file's toolpath is arcs; 0.5 % is a tight bound on both effects
    // and a very loose one on "the parser lost an entire feature".
    expect(length).toBeGreaterThan(independent.length * 0.995);
    expect(length).toBeLessThan(independent.length * 1.005);
    expect(independent.length).toBeGreaterThan(1000); // sanity: metres of extrusion
  });

  it('emits exactly one segment per extruding linear move', () => {
    const independent = independentToolpath(compiled.gcode);
    const linear = compiled.index.stats.segments - compiled.index.stats.arcSegments;
    expect(linear).toBe(independent.linearMoves);
  });

  it('keeps the machine prime line instead of dropping it as a comment', () => {
    // MEASURED: the Bambu start G-code is copied into the output with its own
    // indentation, so `    G1 X65.000 E1.24726 F2015.5` is a real extruding move that
    // arrives looking like whitespace. Losing it costs 105 moves and 585 mm — and costs
    // them silently, which is why it gets an assertion of its own.
    const independent = independentToolpath(compiled.gcode);
    expect(independent.prologueMoves).toBeGreaterThan(100);
    expect(compiled.gcode).toMatch(/^[ \t]+G1 X[0-9.]+ E[0-9.]/m);
    expect(compiled.index.source.firstObjectLayer).toBe(1);
    expect(compiled.index.layers.count[0]).toBe(independent.prologueMoves);
  });

  it('attributes feature types from `; FEATURE:`', () => {
    const segments = decodeAll(compiled);
    const seen = new Set(segments.map((s) => FEATURE_NAMES[s.feature]));
    // Every role this fixture actually contains. `; FEATURE: Sparse infill` never
    // appears in it — the part is too small for sparse infill — so asserting it would be
    // asserting the parser invents features.
    expect([...seen].sort()).toEqual(
      [
        'Bridge',
        'Custom',
        'Gap infill',
        'Inner wall',
        'Internal solid infill',
        'Outer wall',
        'Overhang wall',
        'Support',
        'Support interface',
        'Top surface',
      ].sort(),
    );
    expect(compiled.index.stats.segmentsWithoutFeature).toBe(0);
    expect(seen.has('Unknown')).toBe(false);

    // A curved outer wall is emitted as arcs, so if arcs were dropped this role would
    // hold almost nothing.
    const outerWall = segments.filter((s) => s.feature === FeatureType.OuterWall);
    expect(outerWall.length).toBeGreaterThan(500);
  });

  it('ignores Bambu T1000 / T1100 / T255 pseudo-tools', () => {
    // MEASURED: these appear in the machine start/end G-code of every X1C slice. A naive
    // `^T(\d+)` would colour the whole model as extruder 1000.
    expect(compiled.gcode).toMatch(/^T1000$/m);
    expect(compiled.gcode).toMatch(/^T1100$/m);
    expect(compiled.index.tools).toBe(1);
    expect(decodeAll(compiled).every((s) => s.tool === 0)).toBe(true);
  });

  it('carries width and height on every segment of the object', () => {
    const { layers, source } = compiled.index;
    const objectStart = (layers.offset[source.firstObjectLayer] as number) / SEGMENT_BYTES;
    const segments = decodeAll(compiled);

    for (const segment of segments.slice(objectStart)) {
      expect(segment.width).toBeGreaterThan(0.05);
      expect(segment.width).toBeLessThan(5);
      expect(segment.height).toBeGreaterThan(0.01);
      expect(segment.height).toBeLessThan(2);
    }

    // The machine's prime line runs before any `; LINE_WIDTH:` or `; LAYER_HEIGHT:`, so
    // it is honestly reported as 0 = unknown rather than given an invented width. The
    // renderer's fallback is `source.nozzleDiameter`.
    expect(segments.slice(0, objectStart).every((s) => s.width === 0)).toBe(true);
    expect(source.nozzleDiameter).toBeGreaterThan(0);
  });

  it('builds a layer index that agrees with the layer markers', () => {
    const independent = independentToolpath(compiled.gcode);
    const { layers } = compiled.index;
    const objectLayer = compiled.index.source.firstObjectLayer;
    expect(layers.z.length).toBe(compiled.index.stats.layers);
    expect(compiled.index.stats.layers).toBe(independent.layers + objectLayer);
    expect(compiled.index.source.headerLayerCount).toBe(independent.layers);

    // Z rises monotonically over the object's layers. Layer 0, when it is the machine's
    // prime line, is at the machine's own priming height and is deliberately excluded.
    for (let i = objectLayer + 1; i < layers.z.length; i += 1) {
      expect(layers.z[i] as number).toBeGreaterThan(layers.z[i - 1] as number);
    }
    expect(layers.z.at(-1)).toBeCloseTo(independent.maxZ, 3);
    expect(layers.height.slice(objectLayer).every((h) => h > 0)).toBe(true);

    // Offsets are contiguous and cover the file exactly.
    let expected = 0;
    for (let i = 0; i < layers.offset.length; i += 1) {
      expect(layers.offset[i]).toBe(expected);
      expected += (layers.count[i] as number) * SEGMENT_BYTES;
    }
    expect(expected).toBe(compiled.bin.byteLength);
    expect(layers.count.reduce((a, b) => a + b, 0)).toBe(compiled.index.stats.segments);
  });

  it('keeps every segment of a layer inside that layer', () => {
    const { layers, quantisation } = compiled.index;
    for (let i = 0; i < layers.z.length; i += 1) {
      const range = layerRange(compiled.index, i, i);
      if (range === undefined || range.length === 0) continue;
      const chunk = new Uint8Array(
        compiled.bin.buffer,
        compiled.bin.byteOffset + range.offset,
        range.length,
      );
      const segments = decodeSegments(chunk, quantisation);
      expect(segments.length).toBe(layers.count[i]);
      const z = layers.z[i] as number;
      for (const segment of segments) {
        // A segment may lift slightly (Z hop is a travel, but arcs interpolate Z), so the
        // bound is a layer height rather than exact equality.
        expect(Math.abs(segment.z1 - z)).toBeLessThan(1);
      }
    }
  });

  it('marks which features a layer contains', () => {
    const { layers } = compiled.index;
    for (let i = 0; i < layers.z.length; i += 1) {
      const range = layerRange(compiled.index, i, i);
      if (range === undefined || range.length === 0) continue;
      const chunk = new Uint8Array(
        compiled.bin.buffer,
        compiled.bin.byteOffset + range.offset,
        range.length,
      );
      let mask = 0;
      for (const segment of decodeSegments(chunk, compiled.index.quantisation))
        mask |= 1 << segment.feature;
      expect(mask).toBe(layers.featureMask[i]);
    }
  });

  it('reads the header facts a renderer needs', () => {
    expect(compiled.index.source.nozzleDiameter).toBe(0.4);
    expect(compiled.index.source.filamentColours).toEqual(['#F2754E']);
  });

  it('quantises the whole toolpath inside the declared bounds', () => {
    const { bounds } = compiled.index;
    for (const segment of decodeAll(compiled)) {
      for (const [value, axis] of [
        [segment.x0, 0],
        [segment.y0, 1],
        [segment.z0, 2],
        [segment.x1, 0],
        [segment.y1, 1],
        [segment.z1, 2],
      ] as const) {
        expect(value).toBeGreaterThanOrEqual((bounds.min[axis] as number) - 1e-6);
        expect(value).toBeLessThanOrEqual((bounds.max[axis] as number) + 1e-6);
      }
    }
  });

  it('is smaller than the G-code it came from', async () => {
    const source = await stat(join(scratch, 'orca-2.4.2-arcs-features.gcode'));
    expect(compiled.bin.byteLength).toBeLessThan(source.size);
  });
});

// ---------------------------------------------------------------------------

describe('real OrcaSlicer 2.4.2 output — absolute extrusion with G92 resets', () => {
  let compiled: Compiled;

  beforeAll(async () => {
    compiled = await compileFixture('orca-2.4.2-absolute-e');
  });

  it('is genuinely absolute-E output', () => {
    expect(compiled.gcode).toContain('; use_relative_e_distances = 0');
    expect(compiled.gcode).toMatch(/^[ \t]*M82\b/m);
    expect((compiled.gcode.match(/^G92 E/gm) ?? []).length).toBeGreaterThan(10);
    // The odometer really does climb: this is the shape a relative-only parser breaks on.
    const values = [...compiled.gcode.matchAll(/^G1 X[0-9.]+ Y[0-9.]+ E([0-9.]+)/gm)].map((m) =>
      Number.parseFloat(m[1] as string),
    );
    expect(values.length).toBeGreaterThan(50);
    expect(Math.max(...values)).toBeGreaterThan(10);
  });

  it('reproduces the toolpath', () => {
    const independent = independentToolpath(compiled.gcode);
    const length = decodeAll(compiled).reduce(
      (sum, s) => sum + Math.hypot(s.x1 - s.x0, s.y1 - s.y0, s.z1 - s.z0),
      0,
    );
    expect(independent.length).toBeGreaterThan(100);
    expect(length).toBeGreaterThan(independent.length * 0.995);
    expect(length).toBeLessThan(independent.length * 1.005);
  });

  it('does not mistake the rising odometer for one enormous extrusion', () => {
    // Failing to subtract the previous E — or ignoring `G92 E0` — makes every move look
    // like it extrudes, which drags travels into the preview as spurious segments.
    const segments = decodeAll(compiled);
    const longest = Math.max(...segments.map((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0)));
    expect(longest).toBeLessThan(30); // the part is 20 mm across
    expect(compiled.index.stats.segments).toBeGreaterThan(200);
    expect(segments.every((s) => s.feature !== FeatureType.Unknown)).toBe(true);
  });
});
