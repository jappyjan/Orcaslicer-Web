/**
 * `compilePreview` on inputs that are not a healthy slice.
 *
 * The happy path is covered against real OrcaSlicer output in `real-output.test.ts`;
 * these are the shapes a preview endpoint has to survive rather than 500 on.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compilePreview } from './build.js';
import { decodeSegments } from './encode.js';
import { PREVIEW_FORMAT, PREVIEW_VERSION, SEGMENT_BYTES, layerRange } from './format.js';

let scratch = '';

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gcode-build-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function compile(gcode: string): ReturnType<typeof compilePreview> {
  const gcodePath = join(scratch, 'plate_1.gcode');
  await writeFile(gcodePath, gcode);
  return compilePreview({
    gcodePath,
    binPath: join(scratch, 'plate_1.preview.bin'),
    indexPath: join(scratch, 'plate_1.preview.json'),
    plate: 1,
    gcodeName: 'plate_1.gcode',
  });
}

describe('compilePreview', () => {
  it('produces an empty but valid preview for a file with no extrusions', async () => {
    const index = await compile('; HEADER_BLOCK_START\n; total layer number: 0\nG28\nM104 S0\n');
    expect(index.format).toBe(PREVIEW_FORMAT);
    expect(index.version).toBe(PREVIEW_VERSION);
    expect(index.stats.layers).toBe(0);
    expect(index.stats.segments).toBe(0);
    expect(index.stats.bytes).toBe(0);
    expect(index.layers.offset).toEqual([]);
    expect(layerRange(index, 0, 0)).toBeUndefined();
    expect((await stat(join(scratch, 'plate_1.preview.bin'))).size).toBe(0);
  });

  it('survives an empty file', async () => {
    const index = await compile('');
    expect(index.stats.segments).toBe(0);
    expect(index.bounds.min).toEqual([0, 0, 0]);
  });

  it('counts lines it does not understand instead of guessing', async () => {
    const index = await compile('G1 X1 Y1 E1\nhello world\n42\n');
    expect(index.stats.unparsedLines).toBe(2);
  });

  it('writes the index last, so a `.bin` is never served half-written', async () => {
    await compile('M83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nG1 X10 Y0 E.5\n');
    // The temporary the `.bin` is built under must not survive a successful compile.
    await expect(stat(join(scratch, 'plate_1.preview.bin.partial'))).rejects.toThrow();
    const index = JSON.parse(await readFile(join(scratch, 'plate_1.preview.json'), 'utf8')) as {
      stats: { bytes: number };
    };
    expect((await stat(join(scratch, 'plate_1.preview.bin'))).size).toBe(index.stats.bytes);
  });

  it('drops an empty prologue layer and reports firstObjectLayer 0', async () => {
    const index = await compile(
      ['M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2', 'G1 X10 Y0 E.5'].join(
        '\n',
      ),
    );
    expect(index.source.firstObjectLayer).toBe(0);
    expect(index.stats.layers).toBe(1);
    expect(index.layers.z).toEqual([0.2]);
  });

  it('keeps a layer that has no extrusions so the layer numbering stays aligned', async () => {
    const gcode = [
      'M83',
      '; CHANGE_LAYER',
      '; Z_HEIGHT: 0.2',
      'G1 X10 Y0 E.5',
      '; CHANGE_LAYER',
      '; Z_HEIGHT: 0.4',
      'G1 X20 Y0 F9000', // travel only
      '; CHANGE_LAYER',
      '; Z_HEIGHT: 0.6',
      'G1 X30 Y0 E.5',
    ].join('\n');
    const index = await compile(gcode);
    expect(index.layers.z).toEqual([0.2, 0.4, 0.6]);
    expect(index.layers.count).toEqual([1, 0, 1]);
    // The empty layer's chunk is zero bytes, and the offsets still line up.
    expect(index.layers.offset).toEqual([0, SEGMENT_BYTES, SEGMENT_BYTES]);
    expect(layerRange(index, 1, 1)).toEqual({ offset: SEGMENT_BYTES, length: 0 });
  });

  it('quantises against the toolpath, not against whatever the head visited', async () => {
    // The parking move at X250 is a travel: it must not stretch the grid over the bed.
    const index = await compile(
      [
        'M83',
        '; CHANGE_LAYER',
        '; Z_HEIGHT: 0.2',
        'G1 X10 Y10 E.5',
        'G1 X20 Y20 E.5',
        'G0 X250 Y250',
      ].join('\n'),
    );
    expect(index.bounds.max[0]).toBeCloseTo(20, 6);
    const bytes = await readFile(join(scratch, 'plate_1.preview.bin'));
    const segments = decodeSegments(new Uint8Array(bytes), index.quantisation);
    expect(segments).toHaveLength(2);
    expect(segments[1]?.x1).toBeCloseTo(20, 4);
  });
});
