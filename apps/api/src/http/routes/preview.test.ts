/**
 * The preview endpoints, over real HTTP, against real OrcaSlicer output.
 *
 * The point of the exercise is the last test: fetch the index, pick a window of layers,
 * ask for exactly those bytes with a `Range` header, and decode them into segments
 * without ever having downloaded the rest of the model. That is the whole client
 * contract, and it is asserted here so the renderer agent can build against something
 * that is known to work rather than against this file's prose.
 */

import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { SEGMENT_BYTES, decodeSegments, layerRange, type PreviewIndex } from '@orca-web/gcode';
import type { ApiErrorResponse, JobSummary } from '@orca-web/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewStore } from '../../preview/store.js';
import { ArtifactStore } from '../../storage/artifact-store.js';
import type { JobStore } from '../../storage/job-store.js';
import { toHttpFailure } from '../errors.js';
import { registerPreviewRoutes } from './preview.js';

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../test/fixtures/gcode',
);

const JOB_ID = 'job-0000-1111-2222';

function summary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: JOB_ID,
    name: 'tube',
    state: 'succeeded',
    createdAt: new Date(0).toISOString(),
    startedAt: null,
    finishedAt: null,
    percent: 100,
    message: null,
    warnings: [],
    models: [],
    artifacts: [
      {
        name: 'plate_1.gcode',
        bytes: 250705,
        contentType: 'text/x.gcode',
        role: 'gcode',
        plate: 1,
      },
    ],
    stats: null,
    error: null,
    ...overrides,
  };
}

let root = '';
let app: FastifyInstance;
let baseUrl = '';
let jobs = new Map<string, JobSummary>();
let compiles = 0;

async function boot(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'preview-route-'));
  const artifacts = new ArtifactStore(root);
  await mkdir(artifacts.dirFor(JOB_ID), { recursive: true });
  const gcode = gunzipSync(await readFile(join(FIXTURES, 'orca-2.4.2-arcs-features.gcode.gz')));
  await writeFile(join(artifacts.dirFor(JOB_ID), 'plate_1.gcode'), gcode);

  jobs = new Map([[JOB_ID, summary()]]);
  compiles = 0;
  const store = new PreviewStore(artifacts, {
    log: () => {
      compiles += 1;
    },
  });

  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const failure = toHttpFailure(error);
    void reply.status(failure.status).send(failure.body);
  });
  registerPreviewRoutes(app, {
    jobs: { get: (id: string) => jobs.get(id) } as unknown as JobStore,
    preview: store,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

beforeEach(boot);

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function fetchIndex(): Promise<PreviewIndex> {
  const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1`);
  expect(response.status).toBe(200);
  return json<PreviewIndex>(response);
}

// ---------------------------------------------------------------------------

describe('GET /jobs/:id/preview', () => {
  it('lists the previewable plates and how to reach them', async () => {
    const body = await json<{
      jobId: string;
      plates: Array<{ plate: number; links: { index: string; data: string } }>;
    }>(await fetch(`${baseUrl}/jobs/${JOB_ID}/preview`));
    expect(body.jobId).toBe(JOB_ID);
    expect(body.plates).toEqual([
      {
        plate: 1,
        links: {
          index: `/jobs/${JOB_ID}/preview/1`,
          data: `/jobs/${JOB_ID}/preview/1/data`,
        },
      },
    ]);
  });

  it('404s with the standard envelope for an unknown job', async () => {
    const response = await fetch(`${baseUrl}/jobs/nope/preview`);
    expect(response.status).toBe(404);
    const body = await json<ApiErrorResponse>(response);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.retryable).toBe(false);
    expect(body.error.message).toMatch(/^There is no job/);
  });
});

describe('GET /jobs/:id/preview/:plate', () => {
  it('compiles the preview on first request and caches it', async () => {
    const index = await fetchIndex();
    expect(index.format).toBe('orca-web.gcode-preview');
    expect(index.segmentBytes).toBe(SEGMENT_BYTES);
    expect(index.stats.layers).toBe(16);
    expect(index.layers.offset).toHaveLength(index.stats.layers);
    expect(compiles).toBe(1);

    await fetchIndex();
    await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`);
    expect(compiles).toBe(1);
  });

  it('parses once when several requests race', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1`)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(compiles).toBe(1);
  });

  it('is cacheable forever and revalidates to 304', async () => {
    const first = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const second = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('rejects a nonsense plate number', async () => {
    for (const plate of ['0', '-1', 'abc', '1.5']) {
      const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/${plate}`);
      expect(response.status, plate).toBe(400);
      expect((await json<ApiErrorResponse>(response)).error.code).toBe('BAD_REQUEST');
    }
  });

  it('404s for a plate this job does not have', async () => {
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/7`);
    expect(response.status).toBe(404);
    expect((await json<ApiErrorResponse>(response)).error.message).toContain('plate 7');
  });

  it('404s helpfully while the job is still running', async () => {
    jobs.set(JOB_ID, summary({ state: 'running', artifacts: [] }));
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1`);
    expect(response.status).toBe(404);
    expect((await json<ApiErrorResponse>(response)).error.message).toBe(
      'This job has not produced any G-code yet.',
    );
  });
});

describe('GET /jobs/:id/preview/:plate/data', () => {
  it('advertises range support and its own validator', async () => {
    const index = await fetchIndex();
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`);
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-length')).toBe(String(index.stats.bytes));
    // A different representation needs a different tag, or a cache will serve the JSON
    // index for the binary URL.
    expect(response.headers.get('etag')).not.toBe(
      (await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1`)).headers.get('etag'),
    );
  });

  it('serves a HEAD so a client can size the body before fetching it', async () => {
    const index = await fetchIndex();
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(index.stats.bytes));
  });

  it('416s for a range past the end, and says how long the body is', async () => {
    const index = await fetchIndex();
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`, {
      headers: { Range: `bytes=${index.stats.bytes + 10}-${index.stats.bytes + 20}` },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${index.stats.bytes}`);
    expect((await json<ApiErrorResponse>(response)).error.code).toBe('BAD_REQUEST');
  });

  it('ignores a range whose If-Range no longer matches', async () => {
    const index = await fetchIndex();
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`, {
      headers: { Range: 'bytes=0-17', 'If-Range': '"stale"' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(index.stats.bytes));
  });

  it('serves a suffix range', async () => {
    const index = await fetchIndex();
    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`, {
      headers: { Range: `bytes=-${SEGMENT_BYTES}` },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${index.stats.bytes - SEGMENT_BYTES}-${index.stats.bytes - 1}/${index.stats.bytes}`,
    );
    expect((await response.arrayBuffer()).byteLength).toBe(SEGMENT_BYTES);
  });

  // -------------------------------------------------------------------------

  it('loads a layer window by byte range without downloading the model', async () => {
    const index = await fetchIndex();
    const first = 4;
    const last = 7;

    const range = layerRange(index, first, last);
    expect(range).toBeDefined();
    const { offset, length } = range as { offset: number; length: number };

    const response = await fetch(`${baseUrl}/jobs/${JOB_ID}/preview/1/data`, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${offset}-${offset + length - 1}/${index.stats.bytes}`,
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(length);
    // The window is a fraction of the model: that is the entire point of the format. A
    // single layer is a small fraction of it even in a 16-layer fixture; on the 900-layer
    // budget file the same call moves ~30 KB out of 26 MB.
    expect(length).toBeLessThan(index.stats.bytes);
    const one = layerRange(index, 6, 6) as { offset: number; length: number };
    expect(one.length).toBeLessThan(index.stats.bytes / 4);

    const segments = decodeSegments(bytes, index.quantisation);
    const expected = index.layers.count.slice(first, last + 1).reduce((a, b) => a + b, 0);
    expect(segments).toHaveLength(expected);

    // Every segment really is from the requested layers, and nothing else came along.
    const zs = index.layers.z.slice(first, last + 1);
    for (const segment of segments) {
      const nearest = Math.min(...zs.map((z) => Math.abs(segment.z1 - z)));
      expect(nearest).toBeLessThan(0.05);
    }

    // And the chunk boundaries line up: decoding layer by layer from the same buffer
    // gives the same segments in the same order.
    let cursor = 0;
    for (let layer = first; layer <= last; layer += 1) {
      const count = index.layers.count[layer] as number;
      const slice = bytes.subarray(cursor * SEGMENT_BYTES, (cursor + count) * SEGMENT_BYTES);
      expect(decodeSegments(slice, index.quantisation)).toEqual(
        segments.slice(cursor, cursor + count),
      );
      cursor += count;
    }
    expect(cursor).toBe(segments.length);
  });

  it('reuses a preview compiled by an earlier process', async () => {
    await fetchIndex();
    // A restart drops the in-flight map but not the files; a second store over the same
    // directory must not re-parse.
    const artifacts = new ArtifactStore(root);
    let recompiled = 0;
    const fresh = new PreviewStore(artifacts, {
      log: () => {
        recompiled += 1;
      },
    });
    const entry = await fresh.get(summary(), 1);
    expect(recompiled).toBe(0);
    expect(entry.index.stats.layers).toBe(16);
  });
});
