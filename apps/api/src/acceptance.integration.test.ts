/**
 * M1 + M2 ACCEPTANCE TEST — runs against the REAL OrcaSlicer binary and the REAL
 * generated profile catalog baked into the image.
 *
 *   docker compose run --rm integration
 *
 * M1: "an integration test slices three models concurrently, streams progress for each,
 * and leaves zero bytes behind in /work afterwards."
 * M2: "the API can answer 'give me every process preset valid for a Bambu Lab H2S with a
 * 0.4 nozzle' with fully resolved values, and a report lists any profiles whose
 * inheritance failed to resolve." (docs/SPEC.md)
 *
 * Neither the engine nor the profile resolver is mocked here — `createApp` is called
 * with no overrides, so the presets travel through `CatalogProfileResolver` and the
 * generated catalog exactly as they do in production. The working agreement requires the
 * suite to contain at least one real slice, and a mocked acceptance test would prove
 * nothing about the CLI's actual behaviour, which is where every interesting bug in this
 * project lives.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CatalogResponse, ResolvedPresetView } from '@orca-web/catalog';
import type {
  CreateJobResponse,
  HealthResponse,
  JobEvent,
  JobRequest,
  JobSummary,
} from '@orca-web/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from './app.js';
import { binaryStlBox } from './testing/stl.js';

const execFileAsync = promisify(execFile);

const WORK_ROOT = process.env.WORK_DIR ?? '/work';
const ORCA_BIN = process.env.ORCA_BIN ?? 'orca-slicer';

// The presets M0's smoke test proved end to end.
const PRINTER = { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' } as const;
const PROCESS = { kind: 'process', vendor: 'BBL', name: '0.20mm Standard @BBL X1C' } as const;
const FILAMENT = { kind: 'filament', vendor: 'BBL', name: 'Bambu PLA Basic @BBL X1C' } as const;

/** Three distinct models — different content, different hashes, different layer counts. */
const MODELS = [
  { filename: 'box-20.stl', size: 20, expectedLayers: 100 },
  { filename: 'box-15.stl', size: 15, expectedLayers: 75 },
  { filename: 'box-10.stl', size: 10, expectedLayers: 50 },
];

let app: App;
let baseUrl = '';
let dataDir = '';

async function boot(overrides: Partial<App['config']> = {}): Promise<App> {
  const created = await createApp({
    config: {
      workRoot: WORK_ROOT,
      dataDir,
      // Three at once, so "concurrently" is not a figure of speech. The container has
      // four cores; the shipped default is (cores - 1).
      concurrency: 3,
      progressIntervalMs: 500,
      sliceTimeoutMs: 240_000,
      orcaBinary: ORCA_BIN,
      ...overrides,
    },
  });
  await created.server.listen({ host: '127.0.0.1', port: 0 });
  return created;
}

function urlFor(instance: App): string {
  const address = instance.server.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function descriptor(filename: string, name: string): JobRequest {
  return {
    name,
    printer: PRINTER,
    process: PROCESS,
    filaments: [FILAMENT],
    // The preferred input path: geometry reference plus a transform, no client-side 3MF.
    input: {
      kind: 'plates',
      plates: [
        {
          index: 1,
          arrange: false,
          objects: [
            {
              model: { source: 'upload', filename },
              count: 1,
              filaments: [1],
              posX: [128],
              posY: [128],
              posZ: [0],
            },
          ],
        },
      ],
    },
  };
}

async function submit(url: string, model: (typeof MODELS)[number]): Promise<CreateJobResponse> {
  const form = new FormData();
  form.set('descriptor', JSON.stringify(descriptor(model.filename, model.filename)));
  form.append('files', new Blob([new Uint8Array(binaryStlBox(model.size))]), model.filename);
  const response = await fetch(`${url}/jobs`, { method: 'POST', body: form });
  expect(response.status).toBe(202);
  return (await response.json()) as CreateJobResponse;
}

/** Consume the SSE stream to its terminal event. */
async function streamEvents(url: string, id: string): Promise<JobEvent[]> {
  const response = await fetch(`${url}/jobs/${id}/events`);
  expect(response.status).toBe(200);
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

/** Every path under /work, and the bytes they hold. The point of the whole exercise. */
async function measureWorkRoot(): Promise<{ entries: string[]; bytes: number }> {
  const entries: string[] = [];
  let bytes = 0;
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      const label = prefix === '' ? item.name : `${prefix}/${item.name}`;
      entries.push(label);
      if (item.isDirectory()) await walk(path, label);
      else if (item.isFile()) bytes += (await stat(path)).size;
    }
  }
  await walk(WORK_ROOT, '');
  return { entries, bytes };
}

/** Orphaned slicer processes, found without needing procps in the image. */
async function slicerProcesses(): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes('orca-slicer') || cmdline.includes('orcaslicer')) {
        pids.push(Number(entry));
      }
    } catch {
      /* the process exited while we were looking at it */
    }
  }
  return pids;
}

async function waitFor(url: string, id: string, timeoutMs = 240_000): Promise<JobSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await (await fetch(`${url}/jobs/${id}`)).json()) as JobSummary;
    if (job.state !== 'queued' && job.state !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  // Fail loudly rather than skipping: this test existing but not running would be worse
  // than it not existing.
  // MEASURED: every invocation, `--help` included, drops a `result.json` into the
  // current working directory. Run it somewhere disposable or it litters the repo.
  const { stdout } = await execFileAsync(ORCA_BIN, ['--help'], {
    cwd: await mkdtemp(join(tmpdir(), 'orca-probe-')),
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(stdout).toMatch(/^OrcaSlicer-\d/);
  dataDir = await mkdtemp(join(tmpdir(), 'orca-acceptance-'));
  app = await boot();
  baseUrl = urlFor(app);
});

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('M1 acceptance', () => {
  it('slices three models concurrently, streams progress, and leaves zero bytes in /work', async () => {
    const started = Date.now();
    const created = await Promise.all(MODELS.map((model) => submit(baseUrl, model)));
    expect(new Set(created.map((job) => job.models[0]?.id)).size).toBe(3);

    // Stream all three at once — the SSE fan-out has to hold up under concurrency too.
    const streams = created.map((job) => streamEvents(baseUrl, job.id));
    const eventsPerJob = await Promise.all(streams);
    const jobs = await Promise.all(created.map((job) => waitFor(baseUrl, job.id)));
    const wallClock = Date.now() - started;

    for (const [index, job] of jobs.entries()) {
      const model = MODELS[index] as (typeof MODELS)[number];
      const events = eventsPerJob[index] as JobEvent[];

      expect(job.state, `${model.filename}: ${JSON.stringify(job.error)}`).toBe('succeeded');

      // --- progress streamed ---
      const progress = events.filter((event) => event.type === 'progress');
      expect(progress.length, `${model.filename} progress events`).toBeGreaterThanOrEqual(2);
      expect(progress.at(-1)?.percent).toBe(100);
      expect(progress.map((event) => event.percent)).toEqual(
        [...progress.map((event) => event.percent)].sort((a, b) => a - b),
      );
      expect(events.at(-1)?.type).toBe('done');

      // --- results come from the slicer's own report, not from parsing G-code ---
      expect(job.stats?.predictionSeconds).toBeGreaterThan(0);
      // A non-zero mass proves the filament preset reached the CLI fully flattened:
      // with an unresolved `inherits` chain filament_density is 0 and this reads 0.00
      // while the slice still "succeeds" (SPEC verified deviation #1).
      expect(job.stats?.weightGrams).toBeGreaterThan(0);
      expect(job.stats?.totalMetres).toBeGreaterThan(0);
      expect(job.stats?.layerCount).toBe(model.expectedLayers);

      // --- both artefacts are offered ---
      const project = job.artifacts.find((artifact) => artifact.role === 'project');
      const gcode = job.artifacts.find((artifact) => artifact.role === 'gcode');
      expect(project?.name).toBe('result.gcode.3mf');
      expect(gcode?.name).toBe('plate_1.gcode');

      const archive = await fetch(`${baseUrl}/jobs/${job.id}/artifacts/${project?.name}`);
      const archiveBytes = new Uint8Array(await archive.arrayBuffer());
      expect(archiveBytes.byteLength).toBeGreaterThan(1024);
      // A real ZIP, not a truncated file that exit code 0 lied about.
      expect(Array.from(archiveBytes.slice(0, 2))).toEqual([0x50, 0x4b]);

      const text = await (await fetch(`${baseUrl}/jobs/${job.id}/artifacts/${gcode?.name}`)).text();
      expect(text).toContain(`; total layer number: ${model.expectedLayers}`);
      // E values are emitted with no leading digit and arc fitting produces G2/G3
      // (SPEC verified deviation #4), so the pattern allows both.
      expect(/^G[123] .*E-?[0-9.]/m.test(text)).toBe(true);
    }

    // --- the slices really did overlap ---
    const intervals = jobs.map((job) => ({
      from: Date.parse(job.startedAt as string),
      to: Date.parse(job.finishedAt as string),
    }));
    const overlaps = intervals.filter((a) =>
      intervals.some((b) => a !== b && a.from < b.to && b.from < a.to),
    );
    expect(overlaps.length, 'jobs whose run intervals overlap').toBe(3);
    const serialTime = intervals.reduce((sum, span) => sum + (span.to - span.from), 0);
    expect(wallClock).toBeLessThan(serialTime);

    // --- hard constraint #4 ---
    const work = await measureWorkRoot();
    expect(work.entries, `left behind in ${WORK_ROOT}`).toEqual([]);
    expect(work.bytes).toBe(0);
    expect(await slicerProcesses()).toEqual([]);

    console.log(
      `three real slices: wall clock ${wallClock} ms, summed run time ${serialTime} ms, ` +
        `${WORK_ROOT} holds ${work.entries.length} entries / ${work.bytes} bytes`,
    );
  });

  it('cleans up /work when a running slice is cancelled', async () => {
    const created = await submit(baseUrl, MODELS[0] as (typeof MODELS)[number]);

    // Wait until the sandbox actually exists, so this proves cleanup rather than
    // cancelling before anything was created.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const entries = await readdir(WORK_ROOT);
      if (entries.includes(created.id)) break;
      if (Date.now() > deadline) throw new Error('sandbox never appeared');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const response = await fetch(`${baseUrl}/jobs/${created.id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);

    const work = await measureWorkRoot();
    expect(work.entries).toEqual([]);
    expect(work.bytes).toBe(0);
    // The process group must have been killed, not merely detached from.
    expect(await slicerProcesses()).toEqual([]);
  });

  it('kills the process group and cleans up when a slice exceeds its wall-clock limit', async () => {
    // A deadline shorter than process startup: the slicer is guaranteed to still be
    // running when the timer fires, whatever the model. (A 12-triangle box slices in
    // well under a second, so a "generous" deadline would race the slice.)
    const shortLived = await boot({ sliceTimeoutMs: 120, concurrency: 1 });
    const url = urlFor(shortLived);
    try {
      const created = await submit(url, MODELS[0] as (typeof MODELS)[number]);
      const job = await waitFor(url, created.id, 120_000);

      expect(job.state).toBe('failed');
      expect(job.error?.code).toBe('TIMEOUT');
      // Typed, actionable, and free of engine internals.
      expect(job.error?.hint).toBeTruthy();
      expect(JSON.stringify(job.error)).not.toMatch(/orca-slicer|\/work\//);

      const work = await measureWorkRoot();
      expect(work.entries).toEqual([]);
      expect(work.bytes).toBe(0);
      expect(await slicerProcesses()).toEqual([]);
    } finally {
      await shortLived.close();
    }
  });

  it('reports the real engine version through /healthz', async () => {
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as HealthResponse;
    expect(body.engine.id).toBe('orca-cli');
    expect(body.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.queue.driver).toBe('memory');
    // The catalog resolver, not a stopgap, and the real artefact behind it.
    expect(body.profiles.resolver).toBe('catalog');
    expect(body.profiles.catalog?.presets).toBeGreaterThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// M2 acceptance — over HTTP, against the generated catalog in the image
// ---------------------------------------------------------------------------

describe('M2 acceptance', () => {
  it('answers "every process preset valid for a Bambu Lab H2S with a 0.4 nozzle"', async () => {
    const response = await fetch(
      `${baseUrl}/catalog/presets?type=process&model=${encodeURIComponent('Bambu Lab H2S')}&nozzle=0.4`,
    );
    expect(response.status).toBe(200);
    const presets = (await response.json()) as ResolvedPresetView[];

    expect(presets.map((preset) => preset.name)).toEqual([
      '0.08mm High Quality @BBL H2S',
      '0.12mm High Quality @BBL H2S',
      '0.16mm High Quality @BBL H2S',
      '0.16mm Standard @BBL H2S',
      '0.20mm High Quality @BBL H2S',
      '0.20mm Standard @BBL H2S',
      '0.24mm Standard @BBL H2S',
    ]);

    for (const preset of presets) {
      // "Fully resolved": a leaf process preset carries ~10 of its own keys; what comes
      // back carries the whole chain. Anything less and the CLI would fill the gaps from
      // its compiled-in defaults, silently (SPEC deviation #1).
      expect(Object.keys(preset.config).length).toBeGreaterThanOrEqual(160);
      expect(preset.config).not.toHaveProperty('inherits');
      expect(preset.chain.length).toBeGreaterThan(1);
      // The layer height in the preset's name really is the resolved value, not a label
      // (upstream writes "0.08mm …" as `"0.08"` and "0.20mm …" as `"0.2"`).
      expect(Number(preset.config.layer_height)).toBe(Number(preset.name.slice(0, 4)));
    }

    // Static per OrcaSlicer version, so it must be cacheable.
    const etag = response.headers.get('etag') as string;
    expect(etag).toBeTruthy();
    const conditional = await fetch(response.url, { headers: { 'If-None-Match': etag } });
    expect(conditional.status).toBe(304);

    console.log(
      `H2S 0.4 process presets: ${presets
        .map((p) => `${p.name} (${Object.keys(p.config).length} keys)`)
        .join(', ')}`,
    );
  });

  it('serves the browsable index without the preset bodies, and the schema on request', async () => {
    const index = await fetch(`${baseUrl}/catalog`);
    expect(index.status).toBe(200);
    const body = (await index.json()) as CatalogResponse;
    expect(body.orcaVersion).toBe(process.env.ORCA_VERSION ?? '2.4.2');
    expect(body.printerModels.length).toBeGreaterThan(100);
    expect(body).not.toHaveProperty('configSchema');
    // The acceptance artefact: nothing failed to resolve at build time.
    expect(body.counts.resolved).toBe(body.counts.presets);

    const h2s = body.printerModels.find((model) => model.name === 'Bambu Lab H2S');
    expect(h2s?.nozzleVariants.map((variant) => variant.variant)).toEqual([
      '0.2',
      '0.4',
      '0.6',
      '0.8',
    ]);

    const withSchema = (await (
      await fetch(`${baseUrl}/catalog?schema=1`)
    ).json()) as CatalogResponse;
    // 751 preset options in 2.4.2, every one PrintConfig.cpp defines — M6 renders these.
    expect(Object.keys(withSchema.configSchema?.options ?? {}).length).toBeGreaterThan(700);
    expect(withSchema.configSchema?.coverage.missing).toBe(0);
  });

  it('slices with a preset resolved through the catalog and reports a non-zero mass', async () => {
    // The M0 failure mode in one assertion: an unflattened filament preset leaves
    // filament_density at 0, so slice_info reports used_g="0.00" while the CLI exits 0.
    const created = await submit(baseUrl, MODELS[0] as (typeof MODELS)[number]);
    const job = await waitFor(baseUrl, created.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.stats?.weightGrams).toBeGreaterThan(0);
    expect(job.stats?.plates[0]?.filaments[0]?.usedGrams).toBeGreaterThan(0);
    console.log(
      `catalog-resolved slice: ${job.stats?.weightGrams} g, ${job.stats?.totalMetres} m, ` +
        `${job.stats?.layerCount} layers, ${job.stats?.predictionSeconds} s`,
    );
  });
});
