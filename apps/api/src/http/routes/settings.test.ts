/**
 * `GET /settings/resolved` and the user-preset routes over real HTTP.
 *
 * The interesting assertion is the first one: the resolved body carries values *and*
 * their provenance, and only the keys the presets actually set. That is what lets the
 * client say "modified from the preset" without ever comparing against the compiled-in
 * `PrintConfig` default, which for most keys is a different number entirely (SPEC
 * deviation #1).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProfileCatalogQuery,
  type ConfigSchemaDocument,
  type ProfileCatalog,
} from '@orca-web/catalog';
import type {
  ApiErrorResponse,
  PresetRef,
  ResolvedProfile,
  ResolvedSettings,
  UserPreset,
  UserPresetListResponse,
} from '@orca-web/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../../app.js';
import { CatalogService } from '../../catalog/service.js';
import { MockSlicerEngine } from '../../engine/mock-engine.js';
import type { ProfileResolver } from '../../profiles/port.js';

/** Three presets whose keys deliberately overlap, so layering order is observable. */
const PROFILES: Record<PresetRef['kind'], Record<string, unknown>> = {
  machine: {
    printer_model: 'Acme One',
    printable_height: '250',
    // Also set by the process preset below; the process layer must win.
    layer_height: '9',
  },
  process: {
    layer_height: '0.08',
    enable_arc_fitting: '1',
    sparse_infill_pattern: 'crosshatch',
  },
  filament: {
    nozzle_temperature: ['220', '220'],
    filament_type: ['PLA'],
  },
};

class LayeredResolver implements ProfileResolver {
  readonly id = 'layered';
  async resolve(ref: PresetRef): Promise<ResolvedProfile> {
    return { ...ref, values: { ...PROFILES[ref.kind] }, chain: [ref.name] };
  }
}

function emptyCatalog(): ProfileCatalog {
  return {
    orcaVersion: '2.4.2',
    generatedAt: '',
    profilesRoot: '/opt/orcaslicer/resources/profiles',
    vendors: {},
    printerModels: {},
    presets: {},
    machinePresetIds: [],
    compatibility: {},
    report: {
      orcaVersion: '2.4.2',
      generatedAt: '',
      profilesRoot: '',
      counts: {
        vendors: 0,
        printerModels: 0,
        nozzleVariants: 0,
        presets: 0,
        machine: 0,
        process: 0,
        filament: 0,
        instantiable: 0,
        withInherits: 0,
        resolved: 0,
        maxChainDepth: 0,
      },
      unresolved: [],
      structuralProblems: [],
      unevaluatedConditions: [],
      presetsWithNoCompatiblePrinter: [],
    },
  };
}

const SCHEMA: ConfigSchemaDocument = {
  orcaVersion: '2.4.2',
  sources: [],
  generatedAt: '',
  options: {
    layer_height: {
      key: 'layer_height',
      type: 'coFloat',
      valueKind: 'float',
      isArray: false,
      nullable: false,
      mode: 'simple',
      category: 'Quality',
      min: 0.01,
      max: 1,
      default: 0.2,
      section: 'init_fff_params',
      sourceLine: 1,
    },
    enable_arc_fitting: {
      key: 'enable_arc_fitting',
      type: 'coBool',
      valueKind: 'bool',
      isArray: false,
      nullable: false,
      mode: 'advanced',
      category: 'Quality',
      default: false,
      section: 'init_fff_params',
      sourceLine: 2,
    },
    nozzle_temperature: {
      key: 'nozzle_temperature',
      type: 'coInts',
      valueKind: 'int',
      isArray: true,
      nullable: false,
      mode: 'simple',
      default: [200],
      section: 'init_fff_params',
      sourceLine: 3,
    },
  },
  cliOptions: {},
  placeholderOptions: {},
  categories: ['Quality'],
  coverage: {
    definedInPrintConfigDef: 3,
    definedByOverrideLoop: 0,
    definedByAxisLoop: 0,
    redefinedKeys: 0,
    definedTotal: 3,
    extracted: 3,
    missing: 0,
    defaultsUnevaluated: 0,
    extractedNonPreset: 0,
  },
  gaps: [],
};

const QUERY = new URLSearchParams({
  machineVendor: 'ACME',
  machineName: 'Acme One 0.4 nozzle',
  processVendor: 'ACME',
  processName: '0.08mm Fine @Acme',
  filamentVendor: 'ACME',
  filamentName: 'Acme PLA',
}).toString();

let app: App;
let baseUrl = '';
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'settings-test-'));
  app = await createApp({
    config: {
      workRoot: join(root, 'work'),
      dataDir: join(root, 'data'),
      concurrency: 1,
      profileCatalogPath: join(root, 'none.json'),
      configSchemaPath: join(root, 'none.json'),
    },
    engine: new MockSlicerEngine({ steps: 1, stepMs: 1 }),
    resolver: new LayeredResolver(),
    catalog: new CatalogService(new ProfileCatalogQuery(emptyCatalog(), SCHEMA), '2.4.2'),
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('GET /settings/resolved', () => {
  it('returns the flattened preset values with their provenance', async () => {
    const body = (await (
      await fetch(`${baseUrl}/settings/resolved?${QUERY}`)
    ).json()) as ResolvedSettings;

    expect(body.values.layer_height).toBe('0.08');
    expect(body.values.nozzle_temperature).toEqual(['220', '220']);
    expect(body.sources.layer_height).toBe('process');
    expect(body.sources.printable_height).toBe('machine');
    expect(body.sources.nozzle_temperature).toBe('filament');
    expect(body.presets.process.name).toBe('0.08mm Fine @Acme');
  });

  it('layers machine, then process, then filament', async () => {
    // Both presets set `layer_height`; the process one is applied second and wins, which
    // is the order `--load-settings machine;process` gives the engine.
    const body = (await (
      await fetch(`${baseUrl}/settings/resolved?${QUERY}`)
    ).json()) as ResolvedSettings;
    expect(body.values.layer_height).toBe('0.08');
    expect(body.values.layer_height).not.toBe('9');
  });

  it('omits keys no preset sets, so the client can tell them from preset values', async () => {
    // `wall_loops` is not in any of the three presets. Its absence is the signal that the
    // CLI would fall back to its compiled-in default — which is the thing deviation #1
    // makes dangerous to confuse with a chosen value.
    const body = (await (
      await fetch(`${baseUrl}/settings/resolved?${QUERY}`)
    ).json()) as ResolvedSettings;
    expect(body.values).not.toHaveProperty('wall_loops');
  });

  it('400s without the three preset references', async () => {
    const response = await fetch(`${baseUrl}/settings/resolved?machineVendor=ACME`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorResponse).error.code).toBe('BAD_REQUEST');
  });
});

describe('/settings/presets', () => {
  it('saves, lists, replaces and deletes a named set of overrides', async () => {
    const created = await fetch(`${baseUrl}/settings/presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Fast draft',
        overrides: { layer_height: '0.28', enable_arc_fitting: '0' },
        basedOn: { process: { kind: 'process', vendor: 'ACME', name: '0.08mm Fine @Acme' } },
      }),
    });
    expect(created.status).toBe(201);
    const preset = (await created.json()) as UserPreset;
    // Coerced against the schema on the way in, so a saved set cannot become a job the
    // server would reject months later.
    expect(preset.overrides).toEqual({ layer_height: 0.28, enable_arc_fitting: false });

    const listed = (await (
      await fetch(`${baseUrl}/settings/presets`)
    ).json()) as UserPresetListResponse;
    expect(listed.presets.map((entry) => entry.name)).toEqual(['Fast draft']);

    const replaced = await fetch(`${baseUrl}/settings/presets/${preset.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Faster draft', overrides: { layer_height: 0.3 } }),
    });
    expect(((await replaced.json()) as UserPreset).name).toBe('Faster draft');

    expect(
      (await fetch(`${baseUrl}/settings/presets/${preset.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect(
      ((await (await fetch(`${baseUrl}/settings/presets`)).json()) as UserPresetListResponse)
        .presets,
    ).toEqual([]);
  });

  it('rejects a preset naming a setting this OrcaSlicer version does not define', async () => {
    const response = await fetch(`${baseUrl}/settings/presets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', overrides: { not_a_setting: 1 } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorResponse).error.message).toContain('not_a_setting');
  });

  it('404s when deleting something that is not there', async () => {
    expect((await fetch(`${baseUrl}/settings/presets/nope`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});
