/**
 * The four plater routes, with the engine mocked. The real `--arrange 1` runs in
 * `acceptance.integration.test.ts`, against the binary, as the working agreement requires.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  ApiErrorResponse,
  ArrangeResponse,
  BedSpec,
  CreateJobResponse,
  JobSummary,
  PresetRef,
  ResolvedProfile,
  UploadModelsResponse,
} from '@orca-web/shared';
import { profileCatalogPath } from '@orca-web/catalog';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../../app.js';
import { MockSlicerEngine } from '../../engine/mock-engine.js';
import type { ProfileResolver } from '../../profiles/port.js';
import { binaryStlBox } from '../../testing/stl.js';
import { bedSpecFrom, parsePoints } from './plater.js';

class FakeResolver implements ProfileResolver {
  readonly id = 'fake';
  async resolve(ref: PresetRef): Promise<ResolvedProfile> {
    return {
      ...ref,
      values: { printer_model: 'Test Printer', filament_density: '1.24' },
      chain: [ref.name],
    };
  }
}

/** The generated catalog is gitignored; the bed route's live test needs it. */
const hasCatalog = existsSync(profileCatalogPath());

const PRINTER: PresetRef = { kind: 'machine', vendor: 'TEST', name: 'printer' };
const PROCESS: PresetRef = { kind: 'process', vendor: 'TEST', name: 'process' };

let app: App;
let engine: MockSlicerEngine;
let baseUrl = '';
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'plater-test-'));
  engine = new MockSlicerEngine({ steps: 2, stepMs: 2 });
  app = await createApp({
    config: { workRoot: join(root, 'work'), dataDir: join(root, 'data'), concurrency: 2 },
    engine,
    resolver: new FakeResolver(),
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function upload(name = 'cube.stl', size = 20): Promise<string> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(binaryStlBox(size))]), name);
  const response = await fetch(`${baseUrl}/models`, { method: 'POST', body: form });
  const body = (await response.json()) as UploadModelsResponse;
  return (body.models[0] as { id: string }).id;
}

describe('bed geometry', () => {
  it('parses libslic3r’s "256x256" point vectors', () => {
    expect(parsePoints(['0x0', '256x0', '256x256', '0x256'])).toEqual([
      [0, 0],
      [256, 0],
      [256, 256],
      [0, 256],
    ]);
    // Anything unparseable is dropped rather than becoming a NaN that draws a bed at the
    // origin and looks like a rendering bug.
    expect(parsePoints(['nonsense', 7, null])).toEqual([]);
    expect(parsePoints(undefined)).toEqual([]);
  });

  it('reads the plate straight out of a resolved machine preset', () => {
    const spec = bedSpecFrom(
      {
        printer_model: 'Bambu Lab X1 Carbon',
        printable_area: ['0x0', '256x0', '256x256', '0x256'],
        printable_height: 250,
        bed_exclude_area: ['0x0', '18x0', '18x28', '0x28'],
        extruder_offset: ['0x2'],
      },
      PRINTER,
    );
    expect(spec.printableArea).toHaveLength(4);
    expect(spec.printableHeight).toBe(250);
    expect(spec.excludeArea).toHaveLength(4);
    // MEASURED on 2.4.2: G-code coordinates are plate coordinates minus this.
    expect(spec.extruderOffset).toEqual([0, 2]);
  });

  it('reports an empty plate rather than inventing one when the preset is unflattened', () => {
    // SPEC deviation #1: an unresolved preset has no printable_area at all. Guessing a
    // square here would hide the one bug that makes every position wrong.
    const spec = bedSpecFrom({ inherits: 'fdm_machine_common' }, PRINTER);
    expect(spec.printableArea).toEqual([]);
    expect(spec.printableHeight).toBe(0);
  });

  it('says so when the printer does not exist, rather than serving a default bed', async () => {
    const response = await fetch(`${baseUrl}/plater/bed?model=No%20Such%20Printer`);
    // 503 on a checkout that has never run the extractors — /catalog is unavailable
    // there too; 404 when the catalog is present and simply has no such printer.
    expect([404, 503]).toContain(response.status);
  });

  it.skipIf(!hasCatalog)('serves the real 256x256 plate of a Bambu X1 Carbon', async () => {
    const query = new URLSearchParams({
      model: 'Bambu Lab X1 Carbon',
      vendor: 'BBL',
      nozzle: '0.4',
    });
    const response = await fetch(`${baseUrl}/plater/bed?${query.toString()}`);
    expect(response.status).toBe(200);
    const bed = (await response.json()) as BedSpec;
    // The numbers M0 measured against the real binary (SPEC deviation #1): a preset that
    // reached the CLI unflattened reports 200x200x100 instead.
    expect(bed.printableArea).toEqual([
      [0, 0],
      [256, 0],
      [256, 256],
      [0, 256],
    ]);
    expect(bed.printableHeight).toBe(250);
    expect(bed.excludeArea.length).toBeGreaterThan(0);
    expect(bed.extruderOffset).toEqual([0, 2]);
  });
});

describe('GET /models/:id/file', () => {
  it('serves the stored bytes so the browser can draw the mesh', async () => {
    const id = await upload('cube.stl', 20);
    const response = await fetch(`${baseUrl}/models/${id}/file`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('model/stl');
    expect(response.headers.get('cache-control')).toContain('immutable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(binaryStlBox(20).byteLength);
  });

  it('404s for a model that is not in the library', async () => {
    const response = await fetch(`${baseUrl}/models/sha256:${'0'.repeat(64)}/file`);
    expect(response.status).toBe(404);
  });
});

describe('POST /plater/arrange', () => {
  it('stages one file per instance and returns one placement per instance', async () => {
    const id = await upload();
    const response = await fetch(`${baseUrl}/plater/arrange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        printer: PRINTER,
        process: PROCESS,
        objects: [
          { model: { source: 'library', id } },
          { model: { source: 'library', id }, transform: [2, 0, 0, 0, 2, 0, 0, 0, 2] },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ArrangeResponse;
    expect(body.instances).toHaveLength(2);
    expect(body.instances[0]?.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    // Two copies of one model at *different* transforms are two staged files; the
    // scaled one was baked, so the packer measures what the slicer will slice.
    const staged = engine.arranged[0] as string[];
    expect(new Set(staged).size).toBe(2);
  });

  it('leaves nothing behind in /work', async () => {
    const id = await upload();
    await fetch(`${baseUrl}/plater/arrange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        printer: PRINTER,
        process: PROCESS,
        objects: [{ model: { source: 'library', id } }],
      }),
    });
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(root, 'work'))).toEqual([]);
  });

  it('rejects a malformed transform', async () => {
    const id = await upload();
    const response = await fetch(`${baseUrl}/plater/arrange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        printer: PRINTER,
        process: PROCESS,
        objects: [{ model: { source: 'library', id }, transform: [1, 2, 3] }],
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorResponse).error.code).toBe('BAD_REQUEST');
  });
});

describe('POST /jobs/:id/thumbnail', () => {
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  async function sliceSomething(): Promise<string> {
    const id = await upload();
    const form = new FormData();
    form.set(
      'descriptor',
      JSON.stringify({
        printer: PRINTER,
        process: PROCESS,
        filaments: [{ kind: 'filament', vendor: 'TEST', name: 'pla' }],
        input: {
          kind: 'plates',
          plates: [
            {
              index: 1,
              arrange: false,
              objects: [
                { model: { source: 'library', id }, count: 1, posX: [10], posY: [10], posZ: [0] },
              ],
            },
          ],
        },
      }),
    );
    const created = (await (
      await fetch(`${baseUrl}/jobs`, { method: 'POST', body: form })
    ).json()) as CreateJobResponse;
    for (;;) {
      const job = (await (await fetch(`${baseUrl}/jobs/${created.id}`)).json()) as JobSummary;
      if (job.state === 'succeeded') return created.id;
      if (job.state === 'failed') throw new Error('the mock slice failed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('hands the PNG to the engine and updates the artefact length', async () => {
    const jobId = await sliceSomething();
    const before = (await (await fetch(`${baseUrl}/jobs/${jobId}`)).json()) as JobSummary;

    const response = await fetch(`${baseUrl}/jobs/${jobId}/thumbnail`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG,
    });
    expect(response.status).toBe(200);
    expect(engine.thumbnails).toHaveLength(1);
    expect(engine.thumbnails[0]?.plate).toBe(1);

    // Content-Length is served from the stored row, so it has to follow the rewrite.
    const after = (await (await fetch(`${baseUrl}/jobs/${jobId}`)).json()) as JobSummary;
    const project = (list: JobSummary) => list.artifacts.find((a) => a.role === 'project');
    expect(project(after)?.bytes).not.toBe(project(before)?.bytes);
    expect(project(after)?.bytes).toBe(PNG.byteLength);
  });

  it('rejects a body that is not a PNG', async () => {
    const jobId = await sliceSomething();
    const response = await fetch(`${baseUrl}/jobs/${jobId}/thumbnail`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.alloc(0),
    });
    expect(response.status).toBe(400);
  });

  it('404s for an unknown job', async () => {
    const response = await fetch(`${baseUrl}/jobs/nope/thumbnail`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: PNG,
    });
    expect(response.status).toBe(404);
  });
});

describe('the archive rewrite itself', () => {
  it('adds Metadata/plate_1.png and teaches [Content_Types].xml about png', async () => {
    // VERIFIED DEVIATION #5: --min-save omits the member entirely, so this is an
    // addition, not a replacement — including in the content-type map, without which the
    // archive stops being a valid 3MF.
    const { writePlateThumbnail } = await import('../../engine/orca/threemf.js');
    const { zipSync } = await import('fflate');
    const path = join(root, 'result.gcode.3mf');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      zipSync({
        '[Content_Types].xml': new TextEncoder().encode(
          '<?xml version="1.0"?><Types><Default Extension="gcode" ContentType="text/x.gcode"/></Types>',
        ),
        'Metadata/plate_1.gcode': new TextEncoder().encode('; nothing\n'),
      }),
    );

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const result = await writePlateThumbnail(path, 1, png);
    expect(result.replaced).toBe(false);

    const entries = unzipSync(new Uint8Array(await readFile(path)));
    expect(Buffer.from(entries['Metadata/plate_1.png'] as Uint8Array)).toEqual(png);
    expect(new TextDecoder().decode(entries['[Content_Types].xml'] as Uint8Array)).toContain(
      'Extension="png"',
    );
    // The G-code has to survive untouched: it carries its own md5 in the archive.
    expect(new TextDecoder().decode(entries['Metadata/plate_1.gcode'] as Uint8Array)).toBe(
      '; nothing\n',
    );
  });
});
