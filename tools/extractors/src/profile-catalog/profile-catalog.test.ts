import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ProfileCatalogQuery } from '@orca-web/catalog';
import { buildProfileCatalog } from './build-catalog.js';
import { configLookup, evaluateCondition } from './compatibility.js';
import { loadProfiles } from './load-profiles.js';
import { mergeChain, resolveInheritance } from './resolve-inherits.js';

/**
 * A miniature `resources/profiles` tree that reproduces the shapes that matter:
 * a three-level machine chain, a preset inheriting from a parent in a *different*
 * directory (the case the M0 stopgap resolver gets wrong), name-list compatibility,
 * condition compatibility, a printer-less shared filament vendor, a missing parent
 * and an inheritance cycle.
 */
function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-profiles-'));
  const put = (rel: string, value: unknown) => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  };

  put('Acme.json', {
    name: 'Acme Inc',
    version: '01.00.00.01',
    machine_model_list: [{ name: 'Acme One', sub_path: 'machine/Acme One.json' }],
    machine_list: [
      { name: 'fdm_machine_common', sub_path: 'machine/fdm_machine_common.json' },
      { name: 'fdm_acme_common', sub_path: 'machine/fdm_acme_common.json' },
      { name: 'Acme One 0.4 nozzle', sub_path: 'machine/Acme One 0.4 nozzle.json' },
      { name: 'Acme One 0.6 nozzle', sub_path: 'machine/Acme One 0.6 nozzle.json' },
    ],
    process_list: [
      { name: 'fdm_process_common', sub_path: 'process/fdm_process_common.json' },
      { name: '0.20mm Standard @Acme', sub_path: 'process/0.20mm Standard @Acme.json' },
      { name: '0.30mm Draft @Acme 0.6', sub_path: 'process/0.30mm Draft @Acme 0.6.json' },
      { name: 'orphan process', sub_path: 'process/orphan process.json' },
      { name: 'looping a', sub_path: 'process/looping a.json' },
      { name: 'looping b', sub_path: 'process/looping b.json' },
    ],
    filament_list: [
      { name: 'fdm_filament_pla', sub_path: 'filament/fdm_filament_pla.json' },
      { name: 'Acme PLA @Acme', sub_path: 'filament/vendorA/Acme PLA @Acme.json' },
    ],
  });

  put('Acme/machine/fdm_machine_common.json', {
    type: 'machine',
    name: 'fdm_machine_common',
    instantiation: 'false',
    printable_area: ['0x0', '200x0', '200x200', '0x200'],
    printable_height: '100',
    printer_notes: '',
  });
  put('Acme/machine/fdm_acme_common.json', {
    type: 'machine',
    name: 'fdm_acme_common',
    inherits: 'fdm_machine_common',
    instantiation: 'false',
    printable_area: ['0x0', '256x0', '256x256', '0x256'],
    printable_height: '250',
    printer_notes: 'PRINTER_MODEL_ACME_ONE',
  });
  put('Acme/machine/Acme One.json', {
    type: 'machine_model',
    name: 'Acme One',
    nozzle_diameter: '0.4;0.6',
    family: 'ACME',
    machine_tech: 'FFF',
    default_materials: 'Acme PLA @Acme',
  });
  for (const nozzle of ['0.4', '0.6']) {
    put(`Acme/machine/Acme One ${nozzle} nozzle.json`, {
      type: 'machine',
      name: `Acme One ${nozzle} nozzle`,
      inherits: 'fdm_acme_common',
      instantiation: 'true',
      printer_model: 'Acme One',
      printer_variant: nozzle,
      nozzle_diameter: [nozzle],
    });
  }

  put('Acme/process/fdm_process_common.json', {
    type: 'process',
    name: 'fdm_process_common',
    instantiation: 'false',
    layer_height: '0.2',
    wall_loops: '2',
  });
  put('Acme/process/0.20mm Standard @Acme.json', {
    type: 'process',
    name: '0.20mm Standard @Acme',
    inherits: 'fdm_process_common',
    instantiation: 'true',
    compatible_printers: ['Acme One 0.4 nozzle'],
    // Deliberately contradicts the name list: upstream ignores the condition when the
    // list is non-empty, and so must we.
    compatible_printers_condition: 'nozzle_diameter[0]==0.6',
  });
  put('Acme/process/0.30mm Draft @Acme 0.6.json', {
    type: 'process',
    name: '0.30mm Draft @Acme 0.6',
    inherits: 'fdm_process_common',
    instantiation: 'true',
    layer_height: '0.3',
    compatible_printers_condition:
      'printer_notes=~/.*PRINTER_MODEL_ACME_ONE.*/ and nozzle_diameter[0]==0.6',
  });
  put('Acme/process/orphan process.json', {
    type: 'process',
    name: 'orphan process',
    inherits: 'does_not_exist',
    instantiation: 'true',
  });
  put('Acme/process/looping a.json', {
    type: 'process',
    name: 'looping a',
    inherits: 'looping b',
    instantiation: 'true',
  });
  put('Acme/process/looping b.json', {
    type: 'process',
    name: 'looping b',
    inherits: 'looping a',
    instantiation: 'true',
  });

  put('Acme/filament/fdm_filament_pla.json', {
    type: 'filament',
    name: 'fdm_filament_pla',
    instantiation: 'false',
    filament_density: ['1.24'],
    filament_type: ['PLA'],
  });
  // Lives in a sub-directory while its parent is one level up — the case the M0
  // same-directory stopgap cannot resolve.
  put('Acme/filament/vendorA/Acme PLA @Acme.json', {
    type: 'filament',
    name: 'Acme PLA @Acme',
    inherits: 'fdm_filament_pla',
    instantiation: 'true',
    filament_density: ['1.26'],
    compatible_printers: ['Acme One 0.4 nozzle', 'Acme One 0.6 nozzle'],
  });

  // A vendor with no printers at all: its filaments are offered for every printer.
  put('SharedLibrary.json', {
    name: 'Shared Library',
    filament_list: [
      { name: 'Generic PETG @System', sub_path: 'filament/Generic PETG @System.json' },
    ],
  });
  put('SharedLibrary/filament/Generic PETG @System.json', {
    type: 'filament',
    name: 'Generic PETG @System',
    instantiation: 'true',
    filament_density: ['1.27'],
    compatible_printers: [],
  });

  return root;
}

const root = writeFixture();
const generated = mkdtempSync(join(tmpdir(), 'orca-generated-'));
const { catalog } = buildProfileCatalog({
  version: 'test',
  profilesDir: root,
  outputPath: join(generated, 'catalog.json'),
  reportPath: join(generated, 'report.json'),
});
const query = new ProfileCatalogQuery(catalog);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(generated, { recursive: true, force: true });
});

describe('loadProfiles', () => {
  it('indexes presets by vendor, type and name across nested directories', () => {
    const profiles = loadProfiles(root);
    expect(profiles.vendors.size).toBe(2);
    expect(profiles.presets.get('Acme/filament/Acme PLA @Acme')?.file).toBe(
      'Acme/filament/vendorA/Acme PLA @Acme.json',
    );
    expect(profiles.machineModels.get('Acme/Acme One')?.name).toBe('Acme One');
  });
});

describe('resolveInheritance', () => {
  const profiles = loadProfiles(root);
  const resolution = resolveInheritance(profiles);

  it('resolves a parent that lives in another directory', () => {
    const chain = resolution.chains.get('Acme/filament/Acme PLA @Acme');
    expect(chain).toEqual(['Acme/filament/fdm_filament_pla', 'Acme/filament/Acme PLA @Acme']);
  });

  it('flattens a multi-level machine chain to the leaf-most value', () => {
    const chain = resolution.chains.get('Acme/machine/Acme One 0.4 nozzle') as string[];
    expect(chain).toHaveLength(3);
    const merged = mergeChain(chain, (id) => profiles.presets.get(id)?.own);
    // The M0-measured numbers: without flattening the CLI would use 200x200 / 100.
    expect(merged.printable_area).toEqual(['0x0', '256x0', '256x256', '0x256']);
    expect(merged.printable_height).toBe('250');
    expect(merged.name).toBe('Acme One 0.4 nozzle');
  });

  it('reports a missing parent instead of dropping the preset silently', () => {
    const missing = resolution.unresolved.find((u) => u.name === 'orphan process');
    expect(missing?.reason).toBe('missing-parent');
    expect(missing?.detail).toContain('does_not_exist');
  });

  it('reports every preset in an inherits cycle', () => {
    const cycled = resolution.unresolved.filter((u) => u.reason === 'inherits-cycle');
    expect(cycled.map((u) => u.name).sort()).toEqual(['looping a', 'looping b']);
  });

  it('drops the structural keys so a flattened copy has no parent to look for', () => {
    const merged = mergeChain(
      resolution.chains.get('Acme/machine/Acme One 0.4 nozzle') as string[],
      (id) => profiles.presets.get(id)?.own,
    );
    expect(merged).not.toHaveProperty('inherits');
    expect(merged).not.toHaveProperty('instantiation');
  });
});

describe('evaluateCondition', () => {
  const config = { printer_notes: 'PRINTER_MODEL_ACME_ONE', nozzle_diameter: ['0.6'] };
  const lookup = configLookup(config);

  it('evaluates regex match, indexed compare and and/or/not', () => {
    expect(
      evaluateCondition('printer_notes=~/.*ACME_ONE.*/ and nozzle_diameter[0]==0.6', lookup).value,
    ).toBe(true);
    expect(evaluateCondition('nozzle_diameter[0]==0.4', lookup).value).toBe(false);
    expect(evaluateCondition('printer_notes!~/.*HF_NOZZLE.*/', lookup).value).toBe(true);
    expect(evaluateCondition('not (nozzle_diameter[0]==0.4) or false', lookup).value).toBe(true);
  });

  it('treats a missing key as false rather than throwing', () => {
    expect(evaluateCondition('single_extruder_multi_material', lookup)).toEqual({
      value: false,
      evaluated: true,
    });
  });

  it('is permissive and self-reporting when it cannot parse an expression', () => {
    const result = evaluateCondition('this is @@ not valid', lookup);
    expect(result.value).toBe(true);
    expect(result.evaluated).toBe(false);
  });
});

describe('buildProfileCatalog', () => {
  it('counts vendors, printer models and nozzle variants', () => {
    expect(catalog.report.counts.vendors).toBe(2);
    expect(catalog.report.counts.printerModels).toBe(1);
    expect(catalog.report.counts.nozzleVariants).toBe(2);
    expect(catalog.printerModels['Acme/Acme One']?.advertisedNozzleDiameters).toEqual([0.4, 0.6]);
  });

  it('lists exactly the presets whose inheritance failed', () => {
    expect(catalog.report.unresolved.map((u) => u.name).sort()).toEqual([
      'looping a',
      'looping b',
      'orphan process',
    ]);
  });

  it('lets an explicit compatible_printers list win over a contradicting condition', () => {
    expect(query.compatibleMachineIds('Acme/process/0.20mm Standard @Acme')).toEqual([
      'Acme/machine/Acme One 0.4 nozzle',
    ]);
  });

  it('evaluates a condition when there is no explicit list', () => {
    expect(query.compatibleMachineIds('Acme/process/0.30mm Draft @Acme 0.6')).toEqual([
      'Acme/machine/Acme One 0.6 nozzle',
    ]);
  });

  it('offers a printer-less vendor’s filaments to every printer', () => {
    expect(
      query.compatibleMachineIds('SharedLibrary/filament/Generic PETG @System').sort(),
    ).toEqual(['Acme/machine/Acme One 0.4 nozzle', 'Acme/machine/Acme One 0.6 nozzle']);
  });

  it('stores compatibility as indices into the machine preset id table', () => {
    expect(catalog.machinePresetIds).toContain('Acme/machine/Acme One 0.4 nozzle');
    const compat = catalog.compatibility['Acme/process/0.20mm Standard @Acme'];
    expect(compat?.machines.every((i) => Number.isInteger(i))).toBe(true);
  });
});

describe('ProfileCatalogQuery', () => {
  it('answers "every process preset for <printer> with a <nozzle> nozzle", resolved', () => {
    const presets = query.processPresetsFor({ model: 'Acme One', nozzle: 0.6 });
    expect(presets.map((p) => p.name)).toEqual(['0.30mm Draft @Acme 0.6']);
    // Fully resolved: wall_loops comes from the abstract parent, layer_height from the leaf.
    expect(presets[0]?.config.layer_height).toBe('0.3');
    expect(presets[0]?.config.wall_loops).toBe('2');
  });

  it('resolves the machine preset to the M0-measured values', () => {
    const machine = query.machinePresetFor({ model: 'Acme One', nozzle: '0.4' });
    expect(machine?.config.printable_area).toEqual(['0x0', '256x0', '256x256', '0x256']);
    expect(machine?.config.printable_height).toBe('250');
  });

  it('resolves filament density through the chain', () => {
    const filaments = query.filamentPresetsFor({ model: 'Acme One', nozzle: 0.4 });
    expect(filaments.map((f) => f.name).sort()).toEqual(['Acme PLA @Acme', 'Generic PETG @System']);
    expect(filaments.find((f) => f.name === 'Acme PLA @Acme')?.config.filament_density).toEqual([
      '1.26',
    ]);
    expect(filaments.find((f) => f.name === 'Acme PLA @Acme')?.config.filament_type).toEqual([
      'PLA',
    ]);
  });

  it('returns an empty list for a printer or nozzle that does not exist', () => {
    expect(query.processPresetsFor({ model: 'No Such Printer', nozzle: 0.4 })).toEqual([]);
    expect(query.processPresetsFor({ model: 'Acme One', nozzle: 1.2 })).toEqual([]);
    expect(query.getPrinterModel({ model: 'No Such Printer' })).toBeNull();
  });

  it('flattens a preset for the slicer without structural keys', () => {
    const flat = query.flattenForSlicer('Acme/machine/Acme One 0.4 nozzle');
    expect(flat).not.toHaveProperty('inherits');
    expect(flat).not.toHaveProperty('instantiation');
    expect(flat.type).toBe('machine');
    expect(flat.name).toBe('Acme One 0.4 nozzle');
    expect(flat.printable_height).toBe('250');
  });

  it('builds a GET /catalog body that omits the 11k preset bodies', () => {
    const body = query.toCatalogResponse();
    expect(body.vendors.map((v) => v.id).sort()).toEqual(['Acme', 'SharedLibrary']);
    expect(body.printerModels).toHaveLength(1);
    expect(body).not.toHaveProperty('presets');
    expect(() => query.toCatalogResponse({ includeSchema: true })).toThrow(/config schema/);
  });
});
