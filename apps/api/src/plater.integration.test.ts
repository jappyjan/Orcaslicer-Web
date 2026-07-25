/**
 * M4 ACCEPTANCE, server side — the REAL binary, the REAL catalog.
 *
 *   docker compose run --rm integration
 *
 * The milestone's criterion is "a two-object plate arranged entirely on a phone slices to
 * the exact positions shown on screen". The phone half is `test/e2e/plater.mjs`; this file
 * proves the half that has to be true for it to mean anything: **the numbers the plater
 * sends come back out of the G-code**.
 *
 * It measures rather than trusts. Every claim about the CLI that the plater is built on
 * was established here first:
 *
 *  - `pos_x`/`pos_y`/`pos_z` are a **translation of the model's own file coordinates**,
 *    not a placement of its centre. A 20 mm box whose STL spans 0…20, sent at `pos_x=80`,
 *    extrudes across x 80…100.
 *  - **G-code coordinates are plate coordinates minus `extruder_offset`.** A BBL X1C ships
 *    `0x2`, so everything lands 2 mm lower in Y than the plate says. Without this the
 *    "exact positions" test is off by two and looks like a rounding bug.
 *  - **`--arrange 1` cannot be combined with `--load-assemble-list`** (exit -2), which is
 *    why arranging is a separate invocation over positional model paths.
 *  - A rotation baked into the geometry survives the round trip, which is the only way the
 *    plater's rotate mode can mean anything: the plate description has no rotation field.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ArrangeResponse,
  BedSpec,
  CreateJobResponse,
  JobSummary,
  ModelTransform,
  PlateObject,
  UploadModelsResponse,
} from '@orca-web/shared';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from './app.js';
import { binaryStlBox } from './testing/stl.js';

const execFileAsync = promisify(execFile);

const WORK_ROOT = process.env.WORK_DIR ?? '/work';
const ORCA_BIN = process.env.ORCA_BIN ?? 'orca-slicer';

const PRINTER = { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' } as const;
const PROCESS = { kind: 'process', vendor: 'BBL', name: '0.20mm Standard @BBL X1C' } as const;
const FILAMENT = { kind: 'filament', vendor: 'BBL', name: 'Bambu PLA Basic @BBL X1C' } as const;

/**
 * How far a measured extrusion may sit from the predicted edge of the object.
 *
 * The toolpath is a *centreline*: the outer wall of a 0.4 nozzle at 0.42 mm line width is
 * inset by half a line width, so the extremes come in by ~0.21 mm. 0.35 mm accepts that
 * and nothing else — a half-millimetre placement error fails.
 */
const TOLERANCE_MM = 0.35;

let app: App;
let baseUrl = '';
let dataDir = '';

interface Placed {
  /** World bounds the client predicted: `transform · file vertex + pos`. */
  min: [number, number, number];
  max: [number, number, number];
}

interface Cluster {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  points: number;
}

/**
 * Extrusion coordinates from a G-code file, per layer.
 *
 * SPEC deviation #4: E values are emitted with no leading digit (`E.02345`) and arc
 * fitting turns a share of the extrusions into `G2`/`G3`, so `^G1 .*E[0-9]` finds almost
 * nothing. The pattern here accepts G1/G2/G3 and a bare decimal point.
 */
function extrusionsByLayer(gcode: string): Map<number, Array<[number, number]>> {
  const layers = new Map<number, Array<[number, number]>>();
  let x: number | null = null;
  let y: number | null = null;
  let z = 0;
  for (const line of gcode.split('\n')) {
    if (!/^G[0123] /.test(line)) continue;
    const zMatch = / Z(-?[\d.]+)/.exec(line);
    if (zMatch) z = Number.parseFloat(zMatch[1] as string);
    const xMatch = / X(-?[\d.]+)/.exec(line);
    const yMatch = / Y(-?[\d.]+)/.exec(line);
    if (xMatch) x = Number.parseFloat(xMatch[1] as string);
    if (yMatch) y = Number.parseFloat(yMatch[1] as string);
    const eMatch = / E(-?[\d.]*)/.exec(line);
    if (!eMatch || x === null || y === null) continue;
    const extruded = Number.parseFloat(eMatch[1] as string);
    if (!Number.isFinite(extruded) || extruded <= 0) continue;
    const key = Math.round(z * 100) / 100;
    const bucket = layers.get(key);
    if (bucket) bucket.push([x, y]);
    else layers.set(key, [[x, y]]);
  }
  return layers;
}

/**
 * Split one layer's extrusions into per-object clusters along X.
 *
 * A layer well above the first avoids the skirt and the prime line, which belong to the
 * plate rather than to any object; the widest gap between sorted X values is the join
 * between two objects placed side by side.
 */
function clusterByX(points: Array<[number, number]>): Cluster[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  let widest = { gap: 0, index: -1 };
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const gap = (sorted[index + 1] as [number, number])[0] - (sorted[index] as [number, number])[0];
    if (gap > widest.gap) widest = { gap, index };
  }
  const groups =
    widest.gap > 5 ? [sorted.slice(0, widest.index + 1), sorted.slice(widest.index + 1)] : [sorted];
  return groups.map((group) => ({
    minX: Math.min(...group.map((point) => point[0])),
    maxX: Math.max(...group.map((point) => point[0])),
    minY: Math.min(...group.map((point) => point[1])),
    maxY: Math.max(...group.map((point) => point[1])),
    points: group.length,
  }));
}

async function upload(filename: string, size: number): Promise<string> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(binaryStlBox(size))]), filename);
  const response = await fetch(`${baseUrl}/models`, { method: 'POST', body: form });
  expect(response.status).toBe(201);
  const body = (await response.json()) as UploadModelsResponse;
  return (body.models[0] as { id: string }).id;
}

async function slice(objects: PlateObject[]): Promise<JobSummary> {
  const form = new FormData();
  form.set(
    'descriptor',
    JSON.stringify({
      name: 'plater',
      printer: PRINTER,
      process: PROCESS,
      filaments: [FILAMENT],
      // arrange: false — SPEC: pos_x/pos_y are ignored otherwise, silently.
      input: { kind: 'plates', plates: [{ index: 1, arrange: false, objects }] },
    }),
  );
  const created = (await (
    await fetch(`${baseUrl}/jobs`, { method: 'POST', body: form })
  ).json()) as CreateJobResponse;

  const deadline = Date.now() + 300_000;
  for (;;) {
    const job = (await (await fetch(`${baseUrl}/jobs/${created.id}`)).json()) as JobSummary;
    if (job.state !== 'queued' && job.state !== 'running') {
      expect(job.error).toBeNull();
      expect(job.state).toBe('succeeded');
      return job;
    }
    if (Date.now() > deadline) throw new Error(`job stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function gcodeOf(job: JobSummary): Promise<string> {
  const artifact = job.artifacts.find((candidate) => candidate.role === 'gcode');
  expect(artifact).toBeDefined();
  const response = await fetch(`${baseUrl}/jobs/${job.id}/artifacts/${artifact?.name ?? ''}`);
  expect(response.status).toBe(200);
  return response.text();
}

beforeAll(async () => {
  const { stdout } = await execFileAsync(ORCA_BIN, ['--help'], {
    cwd: await mkdtemp(join(tmpdir(), 'orca-probe-')),
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(stdout).toMatch(/^OrcaSlicer-\d/);
  dataDir = await mkdtemp(join(tmpdir(), 'orca-plater-'));
  app = await createApp({
    config: {
      workRoot: WORK_ROOT,
      dataDir,
      concurrency: 2,
      sliceTimeoutMs: 300_000,
      orcaBinary: ORCA_BIN,
    },
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('the build plate comes from the machine preset', () => {
  it('reports the X1C’s real 256 × 256 × 250 plate', async () => {
    const query = new URLSearchParams({
      model: 'Bambu Lab X1 Carbon',
      vendor: 'BBL',
      nozzle: '0.4',
    });
    const bed = (await (
      await fetch(`${baseUrl}/plater/bed?${query.toString()}`)
    ).json()) as BedSpec;
    // SPEC deviation #1: an unflattened preset would say 200 × 200 × 100 here, at exit 0.
    expect(bed.printableArea).toEqual([
      [0, 0],
      [256, 0],
      [256, 256],
      [0, 256],
    ]);
    expect(bed.printableHeight).toBe(250);
    expect(bed.extruderOffset).toEqual([0, 2]);
    expect(bed.excludeArea.length).toBeGreaterThan(2);
  });
});

describe('positions survive the round trip', () => {
  it('slices a two-object plate to exactly the coordinates it was given', async () => {
    const id = await upload('cube20.stl', 20);
    // Two 20 mm cubes, centred at (80, 100) and (170, 160) on the plate. The STL spans
    // 0…20, so `pos` is the centre minus 10 in X and Y.
    const wanted: Array<{ centre: [number, number]; pos: [number, number, number] }> = [
      { centre: [80, 100], pos: [70, 90, 0] },
      { centre: [170, 160], pos: [160, 150, 0] },
    ];
    const job = await slice(
      wanted.map((item, index) => ({
        model: { source: 'library', id },
        count: 1,
        filaments: [1],
        assembleIndex: [index + 1],
        posX: [item.pos[0]],
        posY: [item.pos[1]],
        posZ: [item.pos[2]],
      })),
    );

    const layers = extrusionsByLayer(await gcodeOf(job));
    const keys = [...layers.keys()].sort((a, b) => a - b);
    expect(keys.length).toBeGreaterThan(50);
    // Well above the first layer: no skirt, no prime line, just the two objects.
    const layer = layers.get(keys[Math.floor(keys.length / 2)] as number) as Array<
      [number, number]
    >;
    const clusters = clusterByX(layer).sort((a, b) => a.minX - b.minX);
    expect(clusters).toHaveLength(2);

    // MEASURED: the firmware's own extruder offset is subtracted on the way out, so the
    // G-code names y - 2 for a BBL X1C. Nothing in the plate description does this.
    const offset: [number, number] = [0, 2];
    for (const [index, cluster] of clusters.entries()) {
      const item = wanted[index] as (typeof wanted)[number];
      expect(cluster.minX).toBeCloseTo(item.centre[0] - 10 - offset[0], 0);
      expect(Math.abs(cluster.minX - (item.centre[0] - 10 - offset[0]))).toBeLessThan(TOLERANCE_MM);
      expect(Math.abs(cluster.maxX - (item.centre[0] + 10 - offset[0]))).toBeLessThan(TOLERANCE_MM);
      expect(Math.abs(cluster.minY - (item.centre[1] - 10 - offset[1]))).toBeLessThan(TOLERANCE_MM);
      expect(Math.abs(cluster.maxY - (item.centre[1] + 10 - offset[1]))).toBeLessThan(TOLERANCE_MM);
    }
  }, 300_000);

  it('bakes a rotation into the geometry, because the plate description has no field for one', async () => {
    const id = await upload('slab.stl', 20);
    // 45° about Z. A 20 mm square turned 45° has a 28.284 mm bounding box, and the
    // transform is applied to the file's own coordinates: the box 0…20 becomes
    // -14.142…14.142 in X and 0…28.284 in Y, which is what `pos` then has to correct for.
    const angle = Math.PI / 4;
    const transform: ModelTransform = [
      Math.cos(angle),
      -Math.sin(angle),
      0,
      Math.sin(angle),
      Math.cos(angle),
      0,
      0,
      0,
      1,
    ];
    const halfDiagonal = (20 * Math.SQRT2) / 2;
    const centre: [number, number] = [128, 128];
    const job = await slice([
      {
        model: { source: 'library', id },
        count: 1,
        filaments: [1],
        transform,
        // transformed bounds: x -14.142…14.142 (centre 0), y 0…28.284 (centre 14.142)
        posX: [centre[0]],
        posY: [centre[1] - halfDiagonal],
        posZ: [0],
      },
    ]);

    const layers = extrusionsByLayer(await gcodeOf(job));
    const keys = [...layers.keys()].sort((a, b) => a - b);
    const layer = layers.get(keys[Math.floor(keys.length / 2)] as number) as Array<
      [number, number]
    >;
    const [cluster] = clusterByX(layer);
    expect(cluster).toBeDefined();
    const measured = cluster as Cluster;
    // A turned square is wider than an unturned one — proof the rotation reached the
    // slicer rather than being quietly dropped.
    expect(measured.maxX - measured.minX).toBeGreaterThan(27);
    expect(measured.maxX - measured.minX).toBeLessThan(29);
    expect(Math.abs((measured.minX + measured.maxX) / 2 - centre[0])).toBeLessThan(TOLERANCE_MM);
    expect(Math.abs((measured.minY + measured.maxY) / 2 - (centre[1] - 2))).toBeLessThan(
      TOLERANCE_MM,
    );
  }, 300_000);
});

describe('auto-arrange is the engine’s', () => {
  it('lays out three copies inside the printable area and slices where it said', async () => {
    const id = await upload('cube20.stl', 20);
    const response = await fetch(`${baseUrl}/plater/arrange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        printer: PRINTER,
        process: PROCESS,
        objects: [
          { model: { source: 'library', id } },
          { model: { source: 'library', id } },
          { model: { source: 'library', id } },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const arranged = (await response.json()) as ArrangeResponse;
    expect(arranged.instances).toHaveLength(3);

    const placements: Placed[] = arranged.instances.map((instance) => ({
      min: [instance.position[0], instance.position[1], instance.position[2]],
      max: [instance.position[0] + 20, instance.position[1] + 20, instance.position[2] + 20],
    }));
    // On the plate, not overlapping, and sitting on it.
    for (const placement of placements) {
      expect(placement.min[0]).toBeGreaterThanOrEqual(0);
      expect(placement.max[0]).toBeLessThanOrEqual(256);
      expect(placement.min[1]).toBeGreaterThanOrEqual(0);
      expect(placement.max[1]).toBeLessThanOrEqual(256);
      expect(placement.min[2]).toBeCloseTo(0, 3);
    }
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = placements[i] as Placed;
        const b = placements[j] as Placed;
        const overlaps =
          a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[1] < b.max[1] && a.max[1] > b.min[1];
        expect(overlaps).toBe(false);
      }
    }

    // The point of the endpoint: hand the positions straight back as pos_x/pos_y and the
    // slice matches what was arranged.
    const job = await slice(
      arranged.instances.map((instance, index) => ({
        model: { source: 'library' as const, id },
        count: 1,
        filaments: [1],
        assembleIndex: [index + 1],
        posX: [instance.position[0]],
        posY: [instance.position[1]],
        posZ: [instance.position[2]],
      })),
    );

    const layers = extrusionsByLayer(await gcodeOf(job));
    const keys = [...layers.keys()].sort((a, b) => a - b);
    const layer = layers.get(keys[Math.floor(keys.length / 2)] as number) as Array<
      [number, number]
    >;
    const wantedX = placements.map((placement) => placement.min[0]).sort((a, b) => a - b);
    const measuredX = layer.map((point) => point[0]);
    expect(Math.min(...measuredX)).toBeCloseTo(wantedX[0] as number, 0);
  }, 300_000);
});

describe('the plate preview', () => {
  it('is written into an archive that had no thumbnail at all', async () => {
    const id = await upload('cube20.stl', 20);
    const job = await slice([
      {
        model: { source: 'library', id },
        count: 1,
        filaments: [1],
        posX: [118],
        posY: [118],
        posZ: [0],
      },
    ]);
    const project = job.artifacts.find((artifact) => artifact.role === 'project');
    expect(project).toBeDefined();
    const name = project?.name ?? '';

    // VERIFIED DEVIATION #5: `--min-save` omits Metadata/plate_N.png entirely. Assert the
    // absence first — if upstream starts writing a blank one, the rewrite still has to
    // work, but this is the state the code is written against.
    const before = unzipSync(
      new Uint8Array(
        await (await fetch(`${baseUrl}/jobs/${job.id}/artifacts/${name}`)).arrayBuffer(),
      ),
    );
    expect(Object.keys(before)).not.toContain('Metadata/plate_1.png');

    const png = solidPng();
    const write = await fetch(`${baseUrl}/jobs/${job.id}/thumbnail?plate=1`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(write.status).toBe(200);

    const after = unzipSync(
      new Uint8Array(
        await (await fetch(`${baseUrl}/jobs/${job.id}/artifacts/${name}`)).arrayBuffer(),
      ),
    );
    const thumbnail = after['Metadata/plate_1.png'];
    expect(thumbnail).toBeDefined();
    expect(Buffer.from(thumbnail as Uint8Array)).toEqual(Buffer.from(png));
    // The archive is still an archive, and the G-code inside it is untouched.
    expect(after['Metadata/plate_1.gcode']).toBeDefined();
    expect(new TextDecoder().decode(after['[Content_Types].xml'] as Uint8Array)).toContain(
      'Extension="png"',
    );
  }, 300_000);
});

/** A minimal but genuinely decodable PNG: one non-black pixel, so "non-blank" means something. */
function solidPng(): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  // zlib stream for one filter byte + one RGB pixel, stored (uncompressed) deflate block
  const raw = Buffer.from([0x00, 0x38, 0xbd, 0xf8]);
  const deflate = Buffer.concat([
    Buffer.from([0x78, 0x01, 0x01, raw.length, 0x00, 0xff - raw.length, 0xff]),
    raw,
    adler32(raw),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function adler32(data: Buffer): Buffer {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  return out;
}
