/**
 * `GET /catalog` and `GET /catalog/presets` over real HTTP, against a hand-built
 * catalog so the test runs on a checkout that has never executed the extractors.
 *
 * The same routes are exercised against the *real* 26 MB artefact — 11 551 presets, the
 * "every process preset for a Bambu Lab H2S with a 0.4 nozzle" acceptance query — by
 * `acceptance.integration.test.ts` inside the container.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProfileCatalogQuery,
  type CatalogPreset,
  type ConfigSchemaDocument,
  type ProfileCatalog,
  type ResolvedPresetView,
} from '@orca-web/catalog';
import type {
  ApiErrorResponse,
  HealthResponse,
  PresetRef,
  ResolvedProfile,
} from '@orca-web/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../app.js';
import { CatalogService } from '../catalog/service.js';
import { MockSlicerEngine } from '../engine/mock-engine.js';
import type { ProfileResolver } from '../profiles/port.js';

class FakeResolver implements ProfileResolver {
  readonly id = 'fake';
  async resolve(ref: PresetRef): Promise<ResolvedProfile> {
    return { ...ref, values: { layer_height: '0.2' }, chain: [ref.name] };
  }
}

function preset(
  p: Partial<CatalogPreset> & Pick<CatalogPreset, 'id' | 'name' | 'type'>,
): CatalogPreset {
  return {
    vendor: 'ACME',
    file: `ACME/${p.type}/${p.name}.json`,
    parent: null,
    chain: [p.id],
    instantiable: true,
    own: {},
    ...p,
  };
}

function fixture(): ProfileCatalog {
  const presets: Record<string, CatalogPreset> = {
    'ACME/machine/Acme One 0.4 nozzle': preset({
      id: 'ACME/machine/Acme One 0.4 nozzle',
      name: 'Acme One 0.4 nozzle',
      type: 'machine',
      own: { printer_model: 'Acme One', nozzle_diameter: ['0.4'], printer_variant: '0.4' },
    }),
    'ACME/process/base': preset({
      id: 'ACME/process/base',
      name: 'base',
      type: 'process',
      instantiable: false,
      own: { layer_height: '0.2', wall_loops: '2', sparse_infill_density: '15%' },
    }),
    'ACME/process/0.20mm Standard @Acme': preset({
      id: 'ACME/process/0.20mm Standard @Acme',
      name: '0.20mm Standard @Acme',
      type: 'process',
      parent: 'ACME/process/base',
      chain: ['ACME/process/base', 'ACME/process/0.20mm Standard @Acme'],
      // No `inherits`: the extractor strips the structural keys when it loads a preset,
      // so a catalog entry's `own` never carries one. The assertions below pin that.
      own: { layer_height: '0.2' },
    }),
    'ACME/filament/Acme PLA': preset({
      id: 'ACME/filament/Acme PLA',
      name: 'Acme PLA',
      type: 'filament',
      own: { filament_density: ['1.26'], filament_type: ['PLA'] },
    }),
  };
  const machineId = 'ACME/machine/Acme One 0.4 nozzle';
  const compat = {
    printers: [],
    condition: null,
    prints: [],
    printsCondition: null,
    machines: [0],
    conditionUnevaluated: false,
  };
  return {
    orcaVersion: '2.4.2',
    generatedAt: '2026-01-01T00:00:00.000Z',
    profilesRoot: '/opt/orcaslicer/resources/profiles',
    vendors: {
      ACME: {
        id: 'ACME',
        name: 'Acme Inc',
        printerModels: ['ACME/Acme One'],
        counts: { machine: 1, process: 2, filament: 1 },
      },
    },
    printerModels: {
      'ACME/Acme One': {
        id: 'ACME/Acme One',
        name: 'Acme One',
        vendor: 'ACME',
        advertisedNozzleDiameters: [0.4],
        nozzleVariants: [
          {
            variant: '0.4',
            nozzleDiameter: 0.4,
            machinePresetId: machineId,
            machinePresetName: 'Acme One 0.4 nozzle',
          },
        ],
        defaultMaterials: ['Acme PLA'],
        file: 'ACME/Acme One.json',
      },
    },
    presets,
    machinePresetIds: [machineId],
    compatibility: {
      'ACME/process/base': { ...compat },
      'ACME/process/0.20mm Standard @Acme': { ...compat },
      'ACME/filament/Acme PLA': { ...compat },
    },
    report: {
      orcaVersion: '2.4.2',
      generatedAt: '2026-01-01T00:00:00.000Z',
      profilesRoot: '/opt/orcaslicer/resources/profiles',
      counts: {
        vendors: 1,
        printerModels: 1,
        nozzleVariants: 1,
        presets: 4,
        machine: 1,
        process: 2,
        filament: 1,
        instantiable: 3,
        withInherits: 1,
        resolved: 4,
        maxChainDepth: 2,
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
  generatedAt: '2026-01-01T00:00:00.000Z',
  options: {
    layer_height: {
      key: 'layer_height',
      type: 'coFloat',
      valueKind: 'float',
      isArray: false,
      nullable: false,
      mode: 'simple',
      default: 0.2,
      section: 'PrintConfigDef',
      sourceLine: 1,
    },
  },
  cliOptions: {},
  placeholderOptions: {},
  categories: ['Quality'],
  coverage: {
    definedInPrintConfigDef: 1,
    definedByOverrideLoop: 0,
    definedByAxisLoop: 0,
    redefinedKeys: 0,
    definedTotal: 1,
    extracted: 1,
    missing: 0,
    defaultsUnevaluated: 0,
    extractedNonPreset: 0,
  },
  gaps: [],
};

let app: App;
let baseUrl = '';
let root = '';

async function boot(catalog?: CatalogService): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'catalog-test-'));
  app = await createApp({
    config: {
      workRoot: join(root, 'work'),
      dataDir: join(root, 'data'),
      concurrency: 1,
      // Point the loader at nothing, so which branch runs does not depend on whether
      // this checkout happens to have run the extractors.
      profileCatalogPath: join(root, 'no-such-catalog.json'),
      configSchemaPath: join(root, 'no-such-schema.json'),
    },
    engine: new MockSlicerEngine({ steps: 1, stepMs: 1 }),
    resolver: new FakeResolver(),
    ...(catalog === undefined ? {} : { catalog }),
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await boot(new CatalogService(new ProfileCatalogQuery(fixture(), SCHEMA), '2.4.2'));
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('GET /catalog', () => {
  it('serves the browsable index without the preset bodies', async () => {
    const response = await fetch(`${baseUrl}/catalog`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.orcaVersion).toBe('2.4.2');
    expect(body.vendors).toHaveLength(1);
    expect(body.printerModels).toHaveLength(1);
    // The whole point of the index: 11 551 preset bodies stay out of it.
    expect(body).not.toHaveProperty('presets');
    expect(body).not.toHaveProperty('configSchema');
  });

  it('adds the config schema only when asked', async () => {
    const body = (await (await fetch(`${baseUrl}/catalog?schema=1`)).json()) as {
      configSchema?: ConfigSchemaDocument;
    };
    expect(body.configSchema?.options.layer_height?.mode).toBe('simple');
  });

  it('is cacheable and answers a conditional request with 304', async () => {
    const first = await fetch(`${baseUrl}/catalog`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(first.headers.get('cache-control')).toContain('max-age=');

    const second = await fetch(`${baseUrl}/catalog`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');

    // The ETag is keyed on the pinned version *and* the variant, so ?schema=1 is a
    // different resource and must not be served from the same cache entry.
    const withSchema = await fetch(`${baseUrl}/catalog?schema=1`);
    expect(withSchema.headers.get('etag')).not.toBe(etag);
  });
});

describe('GET /catalog/presets', () => {
  it('answers "every process preset for this printer + nozzle" with resolved values', async () => {
    const response = await fetch(
      `${baseUrl}/catalog/presets?type=process&model=${encodeURIComponent('Acme One')}&nozzle=0.4`,
    );
    expect(response.status).toBe(200);
    const presets = (await response.json()) as ResolvedPresetView[];

    // The abstract base is not offered; only what a user can pick.
    expect(presets.map((p) => p.name)).toEqual(['0.20mm Standard @Acme']);
    const only = presets[0] as ResolvedPresetView;
    // Fully resolved: keys the leaf never mentions come from its parent…
    expect(only.config.wall_loops).toBe('2');
    expect(only.config.sparse_infill_density).toBe('15%');
    // …and `inherits` is gone, because the CLI would not resolve it (SPEC deviation #1).
    expect(only.config).not.toHaveProperty('inherits');
    expect(only.chain).toEqual(['ACME/process/base', 'ACME/process/0.20mm Standard @Acme']);
  });

  it('serves filaments from the same endpoint', async () => {
    const presets = (await (
      await fetch(
        `${baseUrl}/catalog/presets?type=filament&model=${encodeURIComponent('Acme One')}&nozzle=0.4`,
      )
    ).json()) as ResolvedPresetView[];
    expect(presets.map((p) => p.name)).toEqual(['Acme PLA']);
    expect(presets[0]?.config.filament_density).toEqual(['1.26']);
  });

  it('rejects a missing or unknown type', async () => {
    const response = await fetch(`${baseUrl}/catalog/presets?model=Acme%20One`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.hint).toContain('type=process');
  });

  it('404s an unknown printer, and says what does exist', async () => {
    const response = await fetch(`${baseUrl}/catalog/presets?type=process&model=Acme%20Two`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.hint).toBeTruthy();
  });

  it('404s a nozzle the printer does not have, listing the ones it does', async () => {
    const response = await fetch(
      `${baseUrl}/catalog/presets?type=process&model=${encodeURIComponent('Acme One')}&nozzle=0.8`,
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as ApiErrorResponse).toMatchObject({
      error: { code: 'NOT_FOUND', hint: 'Available nozzles: 0.4.' },
    });
  });
});

describe('without the generated artefacts', () => {
  it('reports the catalog as unavailable rather than pretending to be empty', async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await boot();

    const response = await fetch(`${baseUrl}/catalog`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.code).toBe('ENVIRONMENT_ERROR');
    expect(body.error.retryable).toBe(true);
    // User-safe: no file paths, no stack.
    expect(body.error.message).not.toMatch(/\//);

    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as HealthResponse;
    expect(health.profiles.catalog).toBeNull();
  });
});

describe('GET /healthz', () => {
  it('names the resolver and what the catalog holds', async () => {
    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as HealthResponse;
    expect(health.profiles.resolver).toBe('fake');
    expect(health.profiles.catalog).toEqual({
      orcaVersion: '2.4.2',
      vendors: 1,
      printerModels: 1,
      presets: 4,
    });
  });
});
