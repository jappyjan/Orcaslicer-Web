/**
 * The HTTP surface, end to end, with the engine mocked (allowed for the happy path by
 * the working agreement). The real-binary proof is `acceptance.integration.test.ts`.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  ApiErrorResponse,
  CreateJobResponse,
  HealthResponse,
  JobEvent,
  JobRequest,
  JobSummary,
  PresetRef,
  ResolvedProfile,
} from '@orca-web/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../app.js';
import { SliceError } from '../engine/errors.js';
import { MockSlicerEngine } from '../engine/mock-engine.js';
import type { ProfileResolver } from '../profiles/port.js';
import { ProfileNotFoundError } from '../profiles/port.js';

class FakeResolver implements ProfileResolver {
  readonly id = 'fake';
  async resolve(ref: PresetRef): Promise<ResolvedProfile> {
    if (ref.name === 'missing') throw new ProfileNotFoundError(ref);
    return {
      ...ref,
      values: { printer_model: 'Test Printer', filament_density: '1.24' },
      chain: [ref.name],
    };
  }
}

const CUBE = Buffer.from('solid cube\nendsolid cube\n');

/** `Response.json()` is `unknown`; tests assert on shapes they already know. */
async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function descriptor(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    name: 'cube',
    printer: { kind: 'machine', vendor: 'TEST', name: 'printer' },
    process: { kind: 'process', vendor: 'TEST', name: 'process' },
    filaments: [{ kind: 'filament', vendor: 'TEST', name: 'pla' }],
    input: { kind: 'models', models: [{ source: 'upload', filename: 'cube.stl' }] },
    ...overrides,
  };
}

let app: App;
let engine: MockSlicerEngine;
let baseUrl = '';
let root = '';

async function boot(engineOverride?: MockSlicerEngine): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'api-test-'));
  engine = engineOverride ?? new MockSlicerEngine({ steps: 3, stepMs: 5 });
  app = await createApp({
    config: {
      workRoot: join(root, 'work'),
      dataDir: join(root, 'data'),
      concurrency: 2,
      progressIntervalMs: 0,
      sliceTimeoutMs: 5_000,
    },
    engine,
    resolver: new FakeResolver(),
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

async function postJob(
  request: JobRequest = descriptor(),
  files: Array<{ name: string; data: Buffer }> = [{ name: 'cube.stl', data: CUBE }],
): Promise<Response> {
  const form = new FormData();
  form.set('descriptor', JSON.stringify(request));
  for (const file of files) {
    form.append('files', new Blob([new Uint8Array(file.data)]), file.name);
  }
  return fetch(`${baseUrl}/jobs`, { method: 'POST', body: form });
}

async function waitFor(id: string, states: string[], timeoutMs = 5_000): Promise<JobSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await (await fetch(`${baseUrl}/jobs/${id}`)).json()) as JobSummary;
    if (states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job stayed in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Reads an SSE stream until the terminal event or the deadline. */
async function readEvents(id: string, timeoutMs = 5_000): Promise<JobEvent[]> {
  const response = await fetch(`${baseUrl}/jobs/${id}/events`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events: JobEvent[] = [];
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = /^data: (.*)$/m.exec(frame);
      if (data) events.push(JSON.parse(data[1] as string) as JobEvent);
      split = buffer.indexOf('\n\n');
    }
  }
  return events;
}

describe('POST /jobs', () => {
  it('accepts a multipart job and returns 202 with links', async () => {
    const response = await postJob();
    expect(response.status).toBe(202);
    const body = (await response.json()) as CreateJobResponse;
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.state).toBe('queued');
    // The content id comes straight back so a re-slice needs no re-upload.
    expect(body.models[0]?.id).toMatch(/^sha256:/);
    expect(body.links.events).toBe(`/jobs/${body.id}/events`);
  });

  it('runs the job, records stats and publishes both artefacts', async () => {
    const { id } = (await (await postJob()).json()) as CreateJobResponse;
    const job = await waitFor(id, ['succeeded', 'failed']);
    expect(job.state).toBe('succeeded');
    expect(job.stats?.predictionSeconds).toBe(1221);
    expect(job.stats?.weightGrams).toBe(7.54);
    expect(job.stats?.layerCount).toBe(100);
    // Both downloads are offered: the .gcode.3mf and the raw .gcode.
    expect(job.artifacts.map((artifact) => artifact.role).sort()).toEqual(['gcode', 'project']);
  });

  it('serves artefacts after the sandbox is gone', async () => {
    const { id } = (await (await postJob()).json()) as CreateJobResponse;
    await waitFor(id, ['succeeded']);
    expect(await readdir(app.config.workRoot)).toEqual([]);

    const download = await fetch(`${baseUrl}/jobs/${id}/artifacts/plate_1.gcode`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('cube-plate_1.gcode');
    expect(await download.text()).toContain('total layer number');
  });

  it('re-slices from the library with no second upload', async () => {
    const first = (await (await postJob()).json()) as CreateJobResponse;
    const modelId = first.models[0]?.id as string;

    const response = await postJob(
      descriptor({ input: { kind: 'models', models: [{ source: 'library', id: modelId }] } }),
      [],
    );
    expect(response.status).toBe(202);
    const second = (await response.json()) as CreateJobResponse;
    expect(second.models[0]?.id).toBe(modelId);
    await waitFor(second.id, ['succeeded']);
  });

  it('accepts the structured plate input path', async () => {
    const response = await postJob(
      descriptor({
        input: {
          kind: 'plates',
          plates: [
            {
              index: 1,
              arrange: false,
              objects: [
                {
                  model: { source: 'upload', filename: 'cube.stl' },
                  count: 1,
                  posX: [120],
                  posY: [120],
                },
              ],
            },
          ],
        },
      }),
    );
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as CreateJobResponse;
    await waitFor(id, ['succeeded']);
  });

  it('rejects a request with no descriptor', async () => {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(CUBE)]), 'cube.stl');
    const response = await fetch(`${baseUrl}/jobs`, { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect((await json<ApiErrorResponse>(response)).error.code).toBe('BAD_REQUEST');
  });

  it('rejects an unsupported file type', async () => {
    const response = await postJob(descriptor(), [{ name: 'notes.txt', data: CUBE }]);
    expect(response.status).toBe(400);
    const body = await json<ApiErrorResponse>(response);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.hint).toContain('.stl');
  });

  it('404s a preset that does not exist, before the job is created', async () => {
    const response = await postJob(
      descriptor({ process: { kind: 'process', vendor: 'TEST', name: 'missing' } }),
    );
    expect(response.status).toBe(404);
    expect((await json<{ jobs: JobSummary[] }>(await fetch(`${baseUrl}/jobs`))).jobs).toHaveLength(
      0,
    );
  });
});

describe('GET /jobs/:id/events', () => {
  it('streams state and progress and closes on the terminal event', async () => {
    const { id } = (await (await postJob()).json()) as CreateJobResponse;
    const events = await readEvents(id);

    const types = events.map((event) => event.type);
    expect(types).toContain('progress');
    expect(types.at(-1)).toBe('done');

    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.at(-1)?.percent).toBe(100);
    // Warnings are the user's only signal for things like unsupported overhangs, so
    // they must survive throttling and reach the client.
    expect(progress.some((event) => event.warning === 'Unsupported overhangs detected')).toBe(true);

    const done = events.at(-1) as Extract<JobEvent, { type: 'done' }>;
    expect(done.job.stats?.weightGrams).toBe(7.54);
  });

  it('replays events to a client that connects after the job finished', async () => {
    const { id } = (await (await postJob()).json()) as CreateJobResponse;
    await waitFor(id, ['succeeded']);
    const events = await readEvents(id);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('reports a failure as a typed error payload, never a raw dump', async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await boot(
      new MockSlicerEngine({
        steps: 1,
        stepMs: 1,
        failWith: new SliceError(
          'RELATIVE_E_RESET_REQUIRED',
          'This print profile uses relative extruder addressing but never resets the extruder position.',
          {
            hint: 'Add `G92 E0` to the layer-change G-code of the process profile.',
            detail: 'raw stderr',
          },
        ),
      }),
    );

    const { id } = (await (await postJob()).json()) as CreateJobResponse;
    const events = await readEvents(id);
    const failed = events.at(-1) as Extract<JobEvent, { type: 'failed' }>;
    expect(failed.type).toBe('failed');
    expect(failed.error.code).toBe('RELATIVE_E_RESET_REQUIRED');
    expect(failed.error.hint).toContain('G92 E0');
    expect(JSON.stringify(failed)).not.toContain('raw stderr');

    // ...and the sandbox is still gone.
    expect(await readdir(app.config.workRoot)).toEqual([]);
  });
});

describe('DELETE /jobs/:id', () => {
  it('cancels a running job, cleans the sandbox and forgets the job', async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await boot(new MockSlicerEngine({ steps: 200, stepMs: 25 }));

    const { id } = (await (await postJob()).json()) as CreateJobResponse;
    await waitFor(id, ['running']);
    expect(await readdir(app.config.workRoot)).toEqual([id]);

    const response = await fetch(`${baseUrl}/jobs/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    expect(await readdir(app.config.workRoot)).toEqual([]);
    expect((await fetch(`${baseUrl}/jobs/${id}`)).status).toBe(404);
  });

  it('cancels a job that has not started yet', async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await boot(new MockSlicerEngine({ steps: 100, stepMs: 20 }));

    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const body = (await (await postJob()).json()) as CreateJobResponse;
      ids.push(body.id);
    }
    // concurrency is 2, so the last one is still queued.
    const queued = ids.at(-1) as string;
    expect((await fetch(`${baseUrl}/jobs/${queued}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${baseUrl}/jobs/${queued}`)).status).toBe(404);
  });

  it('404s an unknown job', async () => {
    const response = await fetch(`${baseUrl}/jobs/does-not-exist`, { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect((await json<ApiErrorResponse>(response)).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /healthz', () => {
  it('reports the engine and the queue', async () => {
    const body = await json<HealthResponse>(await fetch(`${baseUrl}/healthz`));
    expect(body.ok).toBe(true);
    expect(body.engine.id).toBe('mock');
    expect(body.queue).toMatchObject({ driver: 'memory', concurrency: 2 });
  });
});

describe('concurrency', () => {
  it('never runs more slices at once than the configured limit', async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    let live = 0;
    let peak = 0;
    const tracking = new MockSlicerEngine({
      steps: 6,
      stepMs: 15,
      onSpawn: () => undefined,
    });
    const originalSlice = tracking.slice.bind(tracking);
    tracking.slice = async function* patched(job, options) {
      live += 1;
      peak = Math.max(peak, live);
      try {
        return yield* originalSlice(job, options);
      } finally {
        live -= 1;
      }
    };
    await boot(tracking);

    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(((await (await postJob()).json()) as CreateJobResponse).id);
    }
    for (const id of ids) await waitFor(id, ['succeeded', 'failed']);
    expect(peak).toBeLessThanOrEqual(2);
    expect(await readdir(app.config.workRoot)).toEqual([]);
  });
});
