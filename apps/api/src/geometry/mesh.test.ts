/**
 * The contract these tests exist to protect is one line:
 *
 *     world vertex = transform · file vertex + pos
 *
 * The plater predicts positions with it (apps/web/src/state/plate.ts) and the assemble
 * list supplies the `pos` half, so if baking a transform moved a model by anything other
 * than the transform, every position the user saw on screen would be a lie.
 *
 * Plus SPEC deviation #11: real facet normals, always.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { binaryStlBox } from '../testing/stl.js';
import {
  MeshError,
  bakeTransform,
  boundsOf,
  isIdentityTransform,
  parse3mfModel,
  readMesh,
  readStl,
  transformMesh,
  writeBinaryStl,
} from './mesh.js';

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-test-'));
  temporaries.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(temporaries.map((dir) => rm(dir, { recursive: true, force: true })));
});

const ASCII_CUBE = `solid tiny
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 1 1 0
    vertex 1 0 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 2
    vertex 1 0 2
    vertex 1 1 2
  endloop
endfacet
endsolid tiny
`;

describe('reading', () => {
  it('reads a binary STL', () => {
    const mesh = readStl(binaryStlBox(20));
    expect(mesh.triangleCount).toBe(12);
    expect(boundsOf(mesh)).toEqual({ min: [0, 0, 0], max: [20, 20, 20] });
  });

  it('reads an ASCII STL', () => {
    const mesh = readStl(new TextEncoder().encode(ASCII_CUBE));
    expect(mesh.triangleCount).toBe(2);
    expect(boundsOf(mesh).max).toEqual([1, 1, 2]);
  });

  it('trusts the facet count over the "solid" prefix', () => {
    // Plenty of exporters write "solid …" into a *binary* STL's 80-byte header; the
    // length arithmetic is what actually distinguishes the two.
    const binary = binaryStlBox(19);
    binary.write('solid exported by something', 0, 'ascii');
    expect(readStl(binary).triangleCount).toBe(12);
  });

  it('rejects a file that is neither', () => {
    expect(() => readStl(new TextEncoder().encode('not a model at all'))).toThrow(MeshError);
  });

  it('applies build-item transforms when reading a 3MF model', () => {
    const xml = `<model unit="millimeter"><resources>
      <object id="1" type="model"><mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object>
    </resources><build>
      <item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 20 30"/>
    </build></model>`;
    expect(boundsOf(parse3mfModel(xml))).toEqual({ min: [10, 20, 30], max: [11, 21, 30] });
  });
});

describe('transforming', () => {
  it('is the identity for the identity', () => {
    expect(isIdentityTransform(undefined)).toBe(true);
    expect(isIdentityTransform([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(true);
    expect(isIdentityTransform([1, 0, 0, 0, 1, 0, 0, 0, 2])).toBe(false);
  });

  it('rotates about the file origin, not about the model', () => {
    // 90° about Z. A box at x 0..20 lands at x -20..0, because the transform is applied
    // to the file's own coordinates — the client is what decides where the object then
    // sits, by choosing pos. Getting this backwards would silently offset every rotated
    // object by half its width.
    const rotated = transformMesh(readStl(binaryStlBox(20)), [0, -1, 0, 1, 0, 0, 0, 0, 1]);
    const bounds = boundsOf(rotated);
    expect(bounds.min[0]).toBeCloseTo(-20, 4);
    expect(bounds.max[0]).toBeCloseTo(0, 4);
    expect(bounds.min[1]).toBeCloseTo(0, 4);
    expect(bounds.max[1]).toBeCloseTo(20, 4);
  });

  it('scales', () => {
    const scaled = transformMesh(readStl(binaryStlBox(10)), [2, 0, 0, 0, 2, 0, 0, 0, 0.5]);
    expect(boundsOf(scaled)).toEqual({ min: [0, 0, 0], max: [20, 20, 5] });
  });

  it('flips winding when the transform mirrors', () => {
    // A mirrored transform turns every triangle inside out. The slicer computes its own
    // normals from the winding, so an unflipped mirror slices as a hollow negative.
    const mirrored = transformMesh(readStl(binaryStlBox(10)), [-1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const written = writeBinaryStl(mirrored);
    const first = written.readFloatLE(84);
    const original = writeBinaryStl(readStl(binaryStlBox(10))).readFloatLE(84);
    expect(Math.abs(first)).toBeCloseTo(Math.abs(original), 5);
  });
});

describe('writing', () => {
  it('emits real unit normals — SPEC deviation #11', () => {
    // admesh decides binary-vs-ASCII by looking for a byte > 127 within 128 bytes of
    // offset 80. Zeroed normals on a small box have none, and the slice dies with
    // CLI_DATA_FILE_ERROR at 10 mm while working at 20 mm. Unit normals put a 0x3F or
    // 0x80 into every facet, whatever the model's size.
    const stl = writeBinaryStl(readStl(binaryStlBox(10)));
    expect(stl.readUInt32LE(80)).toBe(12);
    let unit = 0;
    for (let facet = 0; facet < 12; facet += 1) {
      const offset = 84 + facet * 50;
      const length = Math.hypot(
        stl.readFloatLE(offset),
        stl.readFloatLE(offset + 4),
        stl.readFloatLE(offset + 8),
      );
      expect(length).toBeCloseTo(1, 5);
      unit += 1;
    }
    expect(unit).toBe(12);
    const window = stl.subarray(80, 80 + 128);
    expect(window.some((byte) => byte > 127)).toBe(true);
  });

  it('round-trips through bakeTransform', async () => {
    const dir = await scratch();
    const source = join(dir, 'box.stl');
    const destination = join(dir, 'baked.stl');
    await writeFile(source, binaryStlBox(10));

    const bounds = await bakeTransform(source, destination, [2, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(bounds).toEqual({ min: [0, 0, 0], max: [20, 10, 10] });

    const reread = readStl(await readFile(destination));
    expect(reread.triangleCount).toBe(12);
    expect(boundsOf(reread)).toEqual(bounds);
  });

  it('refuses a collapsed transform', async () => {
    const dir = await scratch();
    const source = join(dir, 'box.stl');
    await writeFile(source, binaryStlBox(10));
    await expect(
      bakeTransform(source, join(dir, 'out.stl'), [0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ).rejects.toThrow(MeshError);
  });

  it('reads back what it wrote, by extension', async () => {
    const dir = await scratch();
    const path = join(dir, 'box.stl');
    await writeFile(path, binaryStlBox(15));
    expect(boundsOf(await readMesh(path)).max).toEqual([15, 15, 15]);
  });
});
