/**
 * M5 ACCEPTANCE TEST (server half) — a REAL slice, previewed over REAL HTTP.
 *
 *   docker compose run --rm integration
 *
 * The unit tests compile committed fixtures; this one proves the whole path a client
 * takes: slice with the real OrcaSlicer binary, ask for the preview index, then pull a
 * layer window out of the middle of the model with a `Range` header and decode it. The
 * working agreement requires the suite to contain real slices, and the shape of Orca's
 * output is exactly where this milestone's bugs live (SPEC deviation #4).
 *
 * It slices ONE small box. The 40 MB budget is measured separately and reported in
 * docs/GCODE-PREVIEW-FORMAT.md — a 26 MiB preview does not belong in a test suite that
 * runs on every change.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_NAMES,
  SEGMENT_BYTES,
  decodeSegments,
  layerRange,
  type PreviewIndex,
} from '@orca-web/gcode';
import type { CreateJobResponse, JobEvent, JobRequest } from '@orca-web/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from './app.js';
import { binaryStlBox } from './testing/stl.js';

const WORK_ROOT = process.env.WORK_DIR ?? '/work';
const ORCA_BIN = process.env.ORCA_BIN ?? 'orca-slicer';

const PRINTER = { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' } as const;
const PROCESS = { kind: 'process', vendor: 'BBL', name: '0.20mm Standard @BBL X1C' } as const;
const FILAMENT = { kind: 'filament', vendor: 'BBL', name: 'Bambu PLA Basic @BBL X1C' } as const;

let app: App;
let baseUrl = '';
let dataDir = '';
let jobId = '';
let index: PreviewIndex;

function descriptor(): JobRequest {
  return {
    name: 'preview-box',
    printer: PRINTER,
    process: PROCESS,
    filaments: [FILAMENT],
    input: { kind: 'models', models: [{ source: 'upload', filename: 'box-20.stl' }] },
  };
}

/** Drain the SSE stream until the job reaches a terminal event. */
async function waitForCompletion(id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/jobs/${id}/events`);
  expect(response.ok).toBe(true);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((part) => part.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as JobEvent;
      if (event.type === 'failed') throw new Error(`slice failed: ${event.error.message}`);
      if (event.type === 'done') {
        await reader.cancel();
        return;
      }
    }
  }
  throw new Error('event stream ended without a terminal event');
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'preview-acceptance-'));
  app = await createApp({
    config: {
      workRoot: WORK_ROOT,
      dataDir,
      concurrency: 1,
      progressIntervalMs: 500,
      sliceTimeoutMs: 240_000,
      orcaBinary: ORCA_BIN,
    },
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;

  const form = new FormData();
  form.set('descriptor', JSON.stringify(descriptor()));
  form.append('files', new Blob([new Uint8Array(binaryStlBox(20))]), 'box-20.stl');
  const created = (await (
    await fetch(`${baseUrl}/jobs`, { method: 'POST', body: form })
  ).json()) as CreateJobResponse;
  jobId = created.id;
  await waitForCompletion(jobId);

  const response = await fetch(`${baseUrl}/jobs/${jobId}/preview/1`);
  expect(response.status).toBe(200);
  index = (await response.json()) as PreviewIndex;
}, 300_000);

afterAll(async () => {
  await app?.close();
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

describe('M5 — G-code preview over HTTP, from a real slice', () => {
  it('lists the plate the slice produced', async () => {
    const body = (await (await fetch(`${baseUrl}/jobs/${jobId}/preview`)).json()) as {
      plates: Array<{ plate: number }>;
    };
    expect(body.plates.map((entry) => entry.plate)).toEqual([1]);
  });

  it('indexes the real toolpath', () => {
    expect(index.format).toBe('orca-web.gcode-preview');
    expect(index.segmentBytes).toBe(SEGMENT_BYTES);
    // A 20 mm box at 0.20 mm layers.
    expect(index.stats.layers).toBeGreaterThan(95);
    expect(index.source.headerLayerCount).toBe(100);
    expect(index.stats.segments).toBeGreaterThan(1000);
    expect(index.layers.z.at(-1)).toBeCloseTo(20, 1);

    // Deviation #4's other half: the slicer emits arcs even for a box, and the parser
    // must have found them rather than skipped the lines.
    expect(index.stats.arcsUnsupportedPlane).toBe(0);
    // Nothing was silently dropped.
    expect(index.stats.unparsedLines).toBe(0);
    expect(index.stats.segmentsWithoutFeature).toBe(0);
    // The preview is smaller than the G-code it came from.
    expect(index.stats.bytes).toBeLessThan(1024 * 1024 * 8);
  });

  it('attributes the roles a solid box actually has', () => {
    const present = FEATURE_NAMES.filter((_, value) =>
      index.layers.featureMask.some((mask) => (mask & (1 << value)) !== 0),
    );
    expect(present).toContain('Outer wall');
    expect(present).toContain('Inner wall');
    expect(present).toContain('Sparse infill');
    expect(present).not.toContain('Unknown');
  });

  it('serves a layer window as a byte range and decodes it', async () => {
    const first = Math.floor(index.stats.layers / 2);
    const last = Math.min(index.stats.layers - 1, first + 9);
    const range = layerRange(index, first, last);
    expect(range).toBeDefined();
    const { offset, length } = range as { offset: number; length: number };

    const response = await fetch(`${baseUrl}/jobs/${jobId}/preview/1/data`, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${offset}-${offset + length - 1}/${index.stats.bytes}`,
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(length);
    // Ten layers out of a hundred: the client never held the model.
    expect(length).toBeLessThan(index.stats.bytes / 4);

    const segments = decodeSegments(bytes, index.quantisation);
    expect(segments).toHaveLength(
      index.layers.count.slice(first, last + 1).reduce((sum, count) => sum + count, 0),
    );

    const zs = index.layers.z.slice(first, last + 1);
    for (const segment of segments) {
      expect(Math.min(...zs.map((z) => Math.abs(segment.z1 - z)))).toBeLessThan(0.05);
      // A 20 mm box centred on a 256 mm bed.
      expect(segment.x1).toBeGreaterThan(100);
      expect(segment.x1).toBeLessThan(160);
      expect(segment.width).toBeGreaterThan(0.1);
      expect(segment.tool).toBe(0);
    }
  });

  it('is cached, not reparsed, on the second request', async () => {
    const first = await fetch(`${baseUrl}/jobs/${jobId}/preview/1`);
    const etag = first.headers.get('etag') as string;
    expect(first.headers.get('cache-control')).toContain('immutable');
    const second = await fetch(`${baseUrl}/jobs/${jobId}/preview/1`, {
      headers: { 'If-None-Match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('disappears with the job', async () => {
    const doomed = new FormData();
    doomed.set('descriptor', JSON.stringify(descriptor()));
    doomed.append('files', new Blob([new Uint8Array(binaryStlBox(10))]), 'box-20.stl');
    const created = (await (
      await fetch(`${baseUrl}/jobs`, { method: 'POST', body: doomed })
    ).json()) as CreateJobResponse;
    await waitForCompletion(created.id);
    expect((await fetch(`${baseUrl}/jobs/${created.id}/preview/1`)).status).toBe(200);

    // Hard constraint #4's sibling: the preview lives with the artefacts, so deleting the
    // job takes it too rather than leaving 26 MB per job behind forever.
    expect((await fetch(`${baseUrl}/jobs/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${baseUrl}/jobs/${created.id}/preview/1`)).status).toBe(404);
  }, 300_000);
});
