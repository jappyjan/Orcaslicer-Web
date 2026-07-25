/**
 * The properties `engine/orca/orca-cli-engine.ts` relies on, pinned here rather than
 * discovered in production: a resolved profile is fully flattened, carries no `inherits`,
 * and a missing preset is a typed 404 rather than a partial result.
 *
 * These use a hand-built catalog so they run anywhere. The real artefact is exercised by
 * `packages/catalog/src/generated-artefacts.test.ts` (which needs the extractors to have
 * run) and end to end by `apps/api/src/acceptance.integration.test.ts`.
 */

import { ProfileCatalogQuery, type CatalogPreset, type ProfileCatalog } from '@orca-web/catalog';
import { describe, expect, it } from 'vitest';
import { CatalogProfileResolver } from './catalog-resolver.js';
import { ProfileNotFoundError, ProfileResolutionError } from './port.js';

function preset(partial: Pick<CatalogPreset, 'id' | 'name' | 'chain' | 'own'>): CatalogPreset {
  return {
    type: 'machine',
    vendor: 'TEST',
    file: `TEST/machine/${partial.name}.json`,
    parent: partial.chain.at(-2) ?? null,
    instantiable: true,
    ...partial,
  };
}

/**
 * `base` sits in `machine/` and `child` in `machine/nested/` — the shape the M0 stopgap
 * got wrong (it looked for `<same-dir>/<inherits>.json`, which misses 1939 of the 11 286
 * edges in 2.4.2). The catalog keys on vendor + type + name, so nesting is irrelevant.
 */
function catalogFixture(): ProfileCatalog {
  const presets: Record<string, CatalogPreset> = {
    'TEST/machine/base': preset({
      id: 'TEST/machine/base',
      name: 'base',
      chain: ['TEST/machine/base'],
      own: {
        printable_area: ['0x0', '256x0', '256x256', '0x256'],
        printable_height: '250',
        printer_model: 'Test Printer',
      },
    }),
    'TEST/machine/child': preset({
      id: 'TEST/machine/child',
      name: 'child',
      chain: ['TEST/machine/base', 'TEST/machine/child'],
      own: { nozzle_diameter: ['0.4'], inherits: 'base' },
    }),
    'TEST/machine/empty': preset({
      id: 'TEST/machine/empty',
      name: 'empty',
      chain: ['TEST/machine/empty'],
      own: {},
    }),
  };
  return {
    orcaVersion: '2.4.2',
    generatedAt: '2026-01-01T00:00:00.000Z',
    profilesRoot: '/opt/orcaslicer/resources/profiles',
    vendors: {},
    printerModels: {},
    presets,
    machinePresetIds: [],
    compatibility: {},
    report: {
      orcaVersion: '2.4.2',
      generatedAt: '2026-01-01T00:00:00.000Z',
      profilesRoot: '/opt/orcaslicer/resources/profiles',
      counts: {
        vendors: 1,
        printerModels: 0,
        nozzleVariants: 0,
        presets: 3,
        machine: 3,
        process: 0,
        filament: 0,
        instantiable: 3,
        withInherits: 1,
        resolved: 3,
        maxChainDepth: 2,
      },
      unresolved: [],
      structuralProblems: [],
      unevaluatedConditions: [],
      presetsWithNoCompatiblePrinter: [],
    },
  };
}

function newResolver(): CatalogProfileResolver {
  return new CatalogProfileResolver(new ProfileCatalogQuery(catalogFixture()));
}

describe('CatalogProfileResolver', () => {
  it('flattens the inherits chain and drops the structural key', async () => {
    const profile = await newResolver().resolve({
      kind: 'machine',
      vendor: 'TEST',
      name: 'child',
    });

    // Inherited from a parent in a different directory — exactly what the CLI would NOT
    // do for us, and what the M0 stopgap resolved wrongly.
    expect(profile.values.printable_height).toBe('250');
    expect(profile.values.printer_model).toBe('Test Printer');
    // The child's own key survives.
    expect(profile.values.nozzle_diameter).toEqual(['0.4']);
    // `inherits` must be gone, or the engine adapter rejects the profile.
    expect(profile.values).not.toHaveProperty('inherits');
    expect(profile.chain).toEqual(['child', 'base']);
    expect(profile.kind).toBe('machine');
  });

  it('caches, and hands out values nothing downstream can mutate', async () => {
    const resolver = newResolver();
    const ref = { kind: 'machine', vendor: 'TEST', name: 'child' } as const;
    const [first, second] = await Promise.all([resolver.resolve(ref), resolver.resolve(ref)]);
    expect(first).toBe(second);
    expect(Object.isFrozen(first.values)).toBe(true);
  });

  it('reports a missing preset as not found', async () => {
    await expect(
      newResolver().resolve({ kind: 'machine', vendor: 'TEST', name: 'nope' }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it('does not confuse the three preset families', async () => {
    // `child` exists, but only as a machine preset.
    await expect(
      newResolver().resolve({ kind: 'process', vendor: 'TEST', name: 'child' }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it('treats a preset that resolves to nothing as a resolution failure', async () => {
    // Not a 404: the preset is there. Handing the CLI an empty settings file is the
    // deviation-#1 failure mode in its purest form — every key would come from the
    // compiled-in defaults, at exit 0.
    await expect(
      newResolver().resolve({ kind: 'machine', vendor: 'TEST', name: 'empty' }),
    ).rejects.toBeInstanceOf(ProfileResolutionError);
  });
});
