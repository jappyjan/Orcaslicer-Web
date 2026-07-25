/**
 * Regression tests against the *real* generated artefacts, pinned to the numbers M0
 * measured with the actual 2.4.2 binary (`docs/SPEC.md`, "VERIFIED CLI deviations" #1).
 *
 * They are skipped when `/generated/<version>/` has not been produced yet — the
 * artefacts are gitignored and need `resources/profiles` from the pinned AppImage (see
 * `docs/PROFILE-PIPELINE.md`). Run `npm run -w @orca-web/extractors extract` first, and
 * these become live.
 */

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { openProfileCatalog, type ProfileCatalogQuery } from './catalog-query.js';
import { catalogReportPath, configSchemaPath, ORCA_VERSION, profileCatalogPath } from './paths.js';
import type { CatalogReport, ConfigSchemaDocument } from './types.js';

const hasArtefacts = existsSync(profileCatalogPath()) && existsSync(configSchemaPath());

describe.skipIf(!hasArtefacts)(`generated artefacts for OrcaSlicer ${ORCA_VERSION}`, () => {
  // Opened in a hook, not in the suite body: vitest still evaluates the body of a
  // skipped `describe` to collect its tests, so constructing here would fail the whole
  // file on a machine that has not run the extractors.
  let catalog: ProfileCatalogQuery;
  beforeAll(() => {
    catalog = openProfileCatalog({ includeSchema: true });
  });

  it('resolved every inherits chain in the shipped profile tree', () => {
    const report = JSON.parse(readFileSync(catalogReportPath(), 'utf8')) as CatalogReport;
    expect(report.unresolved).toEqual([]);
    expect(report.counts.resolved).toBe(report.counts.presets);
  });

  it('extracted every option PrintConfig.cpp defines', () => {
    const schema = JSON.parse(readFileSync(configSchemaPath(), 'utf8')) as ConfigSchemaDocument;
    expect(schema.coverage.missing).toBe(0);
    expect(schema.coverage.defaultsUnevaluated).toBe(0);
    expect(schema.orcaVersion).toBe(ORCA_VERSION);
  });

  it('gives the X1C 0.4 the bed M0 measured (256x256 / 250, not 200x200 / 100)', () => {
    const machine = catalog.machinePresetFor({
      vendor: 'BBL',
      model: 'Bambu Lab X1 Carbon',
      nozzle: 0.4,
    });
    expect(machine?.config.printable_area).toEqual(['0x0', '256x0', '256x256', '0x256']);
    expect(machine?.config.printable_height).toBe('250');
    // …and the compiled-in defaults the CLI would silently fall back to instead.
    const defaults = catalog.printConfigDefaults();
    expect(defaults.printable_area).toEqual([
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
    ]);
    expect(defaults.printable_height).toBe(100);
    expect(defaults.filament_density).toEqual([0]);
  });

  it('gives Bambu PLA Basic a real filament_density (1.26, not 0)', () => {
    const pla = catalog
      .filamentPresetsFor({ vendor: 'BBL', model: 'Bambu Lab X1 Carbon', nozzle: 0.4 })
      .find((p) => p.name === 'Bambu PLA Basic @BBL X1C');
    expect(pla?.config.filament_density).toEqual(['1.26']);
  });

  it('answers the acceptance query for a Bambu Lab H2S with a 0.4 nozzle', () => {
    const model = catalog.getPrinterModel({ model: 'Bambu Lab H2S' });
    expect(model?.id).toBe('BBL/Bambu Lab H2S');
    expect(model?.nozzleVariants.map((v) => v.variant)).toEqual(['0.2', '0.4', '0.6', '0.8']);

    const presets = catalog.processPresetsFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      // "fully resolved": a leaf process preset carries ~10 of its own keys; the
      // resolved config carries the whole chain.
      expect(Object.keys(preset.config).length).toBeGreaterThan(100);
      expect(preset.config.layer_height).toBeTypeOf('string');
      expect(preset.config).not.toHaveProperty('inherits');
    }
    expect(presets.map((p) => p.name)).toContain('0.20mm Standard @BBL H2S');
  });

  it('keeps the CLI flag definitions in step with the pinned binary’s --help', () => {
    const schema = JSON.parse(readFileSync(configSchemaPath(), 'utf8')) as ConfigSchemaDocument;
    const goldenPath = new URL('../../../test/golden/orca-slicer-help.txt', import.meta.url);
    if (!existsSync(goldenPath)) return;
    const help = readFileSync(goldenPath, 'utf8');
    const fromBinary = new Set(
      [...help.matchAll(/^\s--([a-z0-9-]+)/gm)].map((m) => m[1] as string),
    );
    const fromSource = new Set(Object.keys(schema.cliOptions).map((k) => k.replace(/_/g, '-')));
    expect([...fromBinary].filter((f) => !fromSource.has(f))).toEqual([]);
    expect([...fromSource].filter((f) => !fromBinary.has(f))).toEqual([]);
  });
});
