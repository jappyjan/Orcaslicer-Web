/**
 * M6 ACCEPTANCE TEST — the real binary, real overrides, real G-code diffs.
 *
 *   docker compose run --rm integration
 *
 * The milestone's criterion is "any option exposed by the schema is editable and
 * **demonstrably affects the output G-code**". The second half is the one worth proving,
 * so every assertion below slices the same box twice — once stock, once with one setting
 * overridden — and compares the two G-code files. A test that only checked the flag
 * reached the command line would pass just as happily if the CLI ignored it, which is
 * precisely the failure mode SPEC deviation #1 warns about.
 *
 * Coverage is one override per `valueKind` that behaves differently on the command line:
 *
 * | kind             | key                       | preset value | override    |
 * | ---------------- | ------------------------- | ------------ | ----------- |
 * | float            | `layer_height`            | 0.2          | 0.28        |
 * | enum             | `sparse_infill_pattern`   | crosshatch   | gyroid      |
 * | bool ON          | `infill_combination`      | 0            | true        |
 * | bool OFF         | `enable_arc_fitting`      | 1            | false       |
 * | int[] per-slot   | `nozzle_temperature`      | ["220","220"]| [235]       |
 *
 * The two booleans are the point of the exercise: `--enable-arc-fitting 0` is rejected
 * with `No such file: 0` (SPEC deviation #23), so the "off" direction is the one a naive
 * serialiser breaks, and the last test in this file runs that naive form against the real
 * binary to keep the deviation honest rather than remembered.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  CreateJobResponse,
  JobRequest,
  JobSummary,
  ResolvedSettings,
  SettingOverrides,
  UserPreset,
} from '@orca-web/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from './app.js';
import { binaryStlBox } from './testing/stl.js';

const execFileAsync = promisify(execFile);

const WORK_ROOT = process.env.WORK_DIR ?? '/work';
const ORCA_BIN = process.env.ORCA_BIN ?? 'orca-slicer';
const ORCA_RESOURCES = process.env.ORCA_RESOURCES ?? '/opt/orcaslicer/resources';

const PRINTER = { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' } as const;
const PROCESS = { kind: 'process', vendor: 'BBL', name: '0.20mm Standard @BBL X1C' } as const;
const FILAMENT = { kind: 'filament', vendor: 'BBL', name: 'Bambu PLA Basic @BBL X1C' } as const;

/** Small enough to slice quickly, big enough for admesh's ASCII/binary sniff (#11). */
const BOX_MM = 12;

let app: App;
let baseUrl = '';
let dataDir = '';

function descriptor(overrides: SettingOverrides): JobRequest {
  return {
    name: 'override-probe',
    printer: PRINTER,
    process: PROCESS,
    filaments: [FILAMENT],
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    input: {
      kind: 'plates',
      plates: [
        {
          index: 1,
          arrange: false,
          objects: [
            {
              model: { source: 'upload', filename: 'box.stl' },
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

async function waitFor(id: string): Promise<JobSummary> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const job = (await (await fetch(`${baseUrl}/jobs/${id}`)).json()) as JobSummary;
    if (job.state !== 'queued' && job.state !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Slice the same box with the given override set and return the G-code it produced. */
async function sliceWith(overrides: SettingOverrides): Promise<string> {
  const form = new FormData();
  form.set('descriptor', JSON.stringify(descriptor(overrides)));
  form.append('files', new Blob([new Uint8Array(binaryStlBox(BOX_MM))]), 'box.stl');
  const response = await fetch(`${baseUrl}/jobs`, { method: 'POST', body: form });
  expect(response.status).toBe(202);
  const created = (await response.json()) as CreateJobResponse;

  const job = await waitFor(created.id);
  expect(job.error).toBeNull();
  expect(job.state).toBe('succeeded');
  const gcode = job.artifacts.find((artifact) => artifact.role === 'gcode');
  expect(gcode).toBeDefined();
  return (
    await fetch(`${baseUrl}/jobs/${created.id}/artifacts/${(gcode as { name: string }).name}`)
  ).text();
}

/**
 * The value the slicer actually used, read out of the G-code's own config block.
 *
 * This is the strongest available statement that a flag took effect: the block is written
 * by the slicer from its fully resolved configuration, after `--load-settings`, after
 * `--load-filaments`, and after the command line.
 */
function configValue(gcode: string, key: string): string | null {
  const match = new RegExp(`^; ${key} = (.*)$`, 'm').exec(gcode);
  return match === null ? null : (match[1] as string).trim();
}

function countLines(gcode: string, pattern: RegExp): number {
  return gcode.split('\n').filter((line) => pattern.test(line)).length;
}

/**
 * Every file under OrcaSlicer's own profile tree, with its size and mtime.
 *
 * Hard constraint #1 keeps the pinned install unmodified, and diff-and-override exists so
 * that changing a setting never needs a profile file at all. Comparing this before and
 * after a run with overrides is how that claim is checked rather than asserted.
 */
async function snapshotProfileTree(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const label = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path, label);
        continue;
      }
      const info = await stat(path);
      out.push(`${label} ${info.size} ${info.mtimeMs}`);
    }
  }
  await walk(join(ORCA_RESOURCES, 'profiles'), '');
  return out.sort();
}

let stock = '';

beforeAll(async () => {
  const { stdout } = await execFileAsync(ORCA_BIN, ['--help'], {
    cwd: await mkdtemp(join(tmpdir(), 'orca-probe-')),
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(stdout).toMatch(/^OrcaSlicer-\d/);

  dataDir = await mkdtemp(join(tmpdir(), 'orca-m6-'));
  app = await createApp({
    config: {
      workRoot: WORK_ROOT,
      dataDir,
      concurrency: 2,
      sliceTimeoutMs: 240_000,
      orcaBinary: ORCA_BIN,
    },
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;

  stock = await sliceWith({});
}, 300_000);

afterAll(async () => {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('M6 acceptance — an override demonstrably changes the G-code', () => {
  it('float: layer_height', async () => {
    expect(configValue(stock, 'layer_height')).toBe('0.2');
    const changed = await sliceWith({ layer_height: 0.28 });

    expect(configValue(changed, 'layer_height')).toBe('0.28');
    // Not just the header: a coarser layer is fewer layers and materially less G-code.
    const stockLayers = countLines(stock, /^; CHANGE_LAYER$/);
    const changedLayers = countLines(changed, /^; CHANGE_LAYER$/);
    expect(changedLayers).toBeLessThan(stockLayers);
    expect(changed.split('\n').length).toBeLessThan(stock.split('\n').length);
    // And the Z steps themselves are 0.28 apart rather than 0.2.
    expect(changed).toMatch(/^; Z_HEIGHT: 0\.76$/m);
    expect(stock).not.toMatch(/^; Z_HEIGHT: 0\.76$/m);
  }, 300_000);

  it('enum: sparse_infill_pattern', async () => {
    expect(configValue(stock, 'sparse_infill_pattern')).toBe('crosshatch');
    const changed = await sliceWith({ sparse_infill_pattern: 'gyroid' });

    expect(configValue(changed, 'sparse_infill_pattern')).toBe('gyroid');
    // A gyroid is a curve, not a lattice: the toolpath count moves a long way.
    expect(Math.abs(changed.split('\n').length - stock.split('\n').length)).toBeGreaterThan(200);
  }, 300_000);

  it('boolean turned ON: infill_combination', async () => {
    expect(configValue(stock, 'infill_combination')).toBe('0');
    const changed = await sliceWith({ infill_combination: true });

    expect(configValue(changed, 'infill_combination')).toBe('1');
    // Combining infill across layers removes whole passes of it.
    expect(changed.split('\n').length).toBeLessThan(stock.split('\n').length);
  }, 300_000);

  it('boolean turned OFF: enable_arc_fitting — the `=` form (SPEC deviation #23)', async () => {
    // The preset switches arc fitting ON, so this is a genuine diff against the preset
    // and not against the compiled-in default, which is off.
    expect(configValue(stock, 'enable_arc_fitting')).toBe('1');
    const stockArcs = countLines(stock, /^G[23] /);
    expect(stockArcs).toBeGreaterThan(20);

    const changed = await sliceWith({ enable_arc_fitting: false });

    expect(configValue(changed, 'enable_arc_fitting')).toBe('0');
    // The visible consequence: the arcs are gone from the model's own toolpaths. A
    // handful survive in the machine's start/end G-code, which is copied verbatim.
    const changedArcs = countLines(changed, /^G[23] /);
    expect(changedArcs).toBeLessThan(stockArcs / 4);
  }, 300_000);

  it('per-extruder array: nozzle_temperature, joined with a comma (SPEC deviation #25)', async () => {
    expect(configValue(stock, 'nozzle_temperature')).toBe('220');
    expect(countLines(stock, /^M10[49] .*S220/)).toBe(6);

    // Two elements, so the vector separator is exercised for real rather than degenerating
    // into a scalar. MEASURED: the `;`-joined form is accepted at exit 0 and silently
    // keeps only the first element, which is why the serialiser must use `,`.
    const changed = await sliceWith({
      nozzle_temperature: [235, 235],
      nozzle_temperature_initial_layer: [235, 235],
    });

    expect(configValue(changed, 'nozzle_temperature')).toBe('235');
    // The temperature commands the printer will actually execute, not just the header:
    // every one of the six moves, and none of the old value survives.
    expect(countLines(changed, /^M10[49] .*S235/)).toBe(6);
    expect(countLines(changed, /^M10[49] .*S220/)).toBe(0);
  }, 300_000);

  it('several at once, and OrcaSlicer’s own profile tree is untouched', async () => {
    const before = await snapshotProfileTree();
    const changed = await sliceWith({
      layer_height: 0.24,
      enable_arc_fitting: false,
      sparse_infill_density: '35%',
      seam_position: 'back',
    });

    expect(configValue(changed, 'layer_height')).toBe('0.24');
    expect(configValue(changed, 'enable_arc_fitting')).toBe('0');
    expect(configValue(changed, 'sparse_infill_density')).toBe('35%');
    expect(configValue(changed, 'seam_position')).toBe('back');

    // Diff-and-override's architectural claim, checked rather than asserted: not one byte
    // of the slicer's profile tree changed.
    expect(await snapshotProfileTree()).toEqual(before);
  }, 300_000);
});

describe('the flag forms, against the real binary', () => {
  /**
   * SPEC deviation #23, re-measured.
   *
   * `--key value` for a boolean is not merely wrong, it is wrong in a way that reads as a
   * missing model file. This test is what stops someone "simplifying" the serialiser back
   * into a `--key value` pair: it fails here, loudly, rather than in production as a
   * confusing 404-shaped error.
   */
  it('rejects the naive `--key value` form for a boolean with a file-not-found error', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-boolflag-'));
    const failure = await execFileAsync(ORCA_BIN, ['--enable-arc-fitting', '0', '--help'], {
      cwd: scratch,
      maxBuffer: 8 * 1024 * 1024,
    }).catch((error: unknown) => error as { stdout?: string; stderr?: string; code?: number });

    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    expect(output).toContain('No such file: 0');
    await rm(scratch, { recursive: true, force: true });
  }, 60_000);

  /** The form the serialiser actually emits, on the same binary, in the same place. */
  it('accepts the `=` form for the same key', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-boolflag-'));
    const { stdout } = await execFileAsync(ORCA_BIN, ['--enable-arc-fitting=0', '--help'], {
      cwd: scratch,
      maxBuffer: 8 * 1024 * 1024,
    });
    expect(stdout).toMatch(/^OrcaSlicer-\d/);
    await rm(scratch, { recursive: true, force: true });
  }, 60_000);
});

describe('the settings surface the UI renders from', () => {
  it('serves the resolved preset — the baseline "modified" is measured against', async () => {
    const query = new URLSearchParams({
      machineVendor: PRINTER.vendor,
      machineName: PRINTER.name,
      processVendor: PROCESS.vendor,
      processName: PROCESS.name,
      filamentVendor: FILAMENT.vendor,
      filamentName: FILAMENT.name,
    });
    const body = (await (
      await fetch(`${baseUrl}/settings/resolved?${query.toString()}`)
    ).json()) as ResolvedSettings;

    // The process preset's real values, fully flattened through its inherits chain.
    expect(body.values.layer_height).toBe('0.2');
    expect(body.sources.layer_height).toBe('process');
    expect(body.values.enable_arc_fitting).toBe('1');
    expect(body.sources.nozzle_temperature).toBe('filament');
    expect(body.sources.printable_area).toBe('machine');

    // The bed is 256x256, not the compiled-in 200x200 — i.e. this is the flattened
    // preset, which is the whole reason deviation #1 needs the catalog at all.
    expect(body.values.printable_area).toEqual(['0x0', '256x0', '256x256', '0x256']);

    // `use_relative_e_distances` is defined by PrintConfig but set by NO preset in this
    // chain. Its absence here is what lets the UI say "slicer built-in" rather than
    // pretending a preset chose it.
    expect(body.values).not.toHaveProperty('use_relative_e_distances');
  }, 60_000);

  it('exposes the whole config schema through GET /catalog?schema=1', async () => {
    const body = (await (await fetch(`${baseUrl}/catalog?schema=1`)).json()) as {
      configSchema: { options: Record<string, { mode: string }>; categories: string[] };
    };
    expect(Object.keys(body.configSchema.options)).toHaveLength(751);
    expect(body.configSchema.categories).toHaveLength(11);
  }, 60_000);

  it('rejects a setting this OrcaSlicer version does not define, rather than dropping it', async () => {
    const form = new FormData();
    form.set('descriptor', JSON.stringify(descriptor({ not_a_real_setting: 1 })));
    form.append('files', new Blob([new Uint8Array(binaryStlBox(BOX_MM))]), 'box.stl');
    const response = await fetch(`${baseUrl}/jobs`, { method: 'POST', body: form });
    expect(response.status).toBe(400);
  }, 60_000);

  it('round-trips a named user preset without writing a profile file anywhere', async () => {
    const before = await snapshotProfileTree();
    const created = await fetch(`${baseUrl}/settings/presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Fast draft',
        overrides: { layer_height: 0.28, enable_arc_fitting: false },
        basedOn: { process: PROCESS },
      }),
    });
    expect(created.status).toBe(201);
    const preset = (await created.json()) as UserPreset;
    expect(preset.overrides).toEqual({ layer_height: 0.28, enable_arc_fitting: false });
    expect(await snapshotProfileTree()).toEqual(before);
  }, 60_000);
});
