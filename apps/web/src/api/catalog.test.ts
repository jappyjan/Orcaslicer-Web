/**
 * The catalog shaping rules that the 390px pickers depend on. Fixtures are trimmed
 * copies of real `GET /catalog` and `GET /catalog/presets` responses from the running
 * container.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  defaultFilament,
  defaultProcess,
  materialsOf,
  searchPresets,
  searchPrinters,
  suggestedPresets,
  toPresetOption,
  type PresetOption,
} from './catalog.ts';

const WIRE_CATALOG = {
  orcaVersion: '2.4.2',
  generatedAt: '',
  counts: { vendors: 2, printerModels: 3, presets: 11551 },
  vendors: [
    // The display name differs from the directory id; the UI must show `Bambulab`.
    {
      id: 'BBL',
      name: 'Bambulab',
      printerModels: ['BBL/Bambu Lab H2S', 'BBL/Bambu Lab X1 Carbon'],
    },
    { id: 'Creality', name: 'Creality', printerModels: ['Creality/Ender-3'] },
    { id: 'Ghost', name: 'Ghost', printerModels: ['Ghost/No Presets'] },
  ],
  printerModels: [
    {
      id: 'BBL/Bambu Lab H2S',
      name: 'Bambu Lab H2S',
      vendor: 'BBL',
      family: 'BBL-3DP',
      // Four diameters advertised, but only two machine presets exist.
      advertisedNozzleDiameters: [0.2, 0.4, 0.6, 0.8],
      nozzleVariants: [
        {
          variant: '0.4',
          nozzleDiameter: 0.4,
          machinePresetId: 'BBL/machine/Bambu Lab H2S 0.4 nozzle',
          machinePresetName: 'Bambu Lab H2S 0.4 nozzle',
        },
        {
          variant: '0.8',
          nozzleDiameter: 0.8,
          machinePresetId: 'BBL/machine/Bambu Lab H2S 0.8 nozzle',
          machinePresetName: 'Bambu Lab H2S 0.8 nozzle',
        },
      ],
      defaultMaterials: ['Bambu PLA Basic @BBL H2S'],
      file: '',
    },
    {
      id: 'BBL/Bambu Lab X1 Carbon',
      name: 'Bambu Lab X1 Carbon',
      vendor: 'BBL',
      advertisedNozzleDiameters: [0.4],
      nozzleVariants: [
        {
          variant: '0.4',
          nozzleDiameter: 0.4,
          machinePresetId: 'BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle',
          machinePresetName: 'Bambu Lab X1 Carbon 0.4 nozzle',
        },
      ],
      defaultMaterials: [],
      file: '',
    },
    {
      id: 'Creality/Ender-3',
      name: 'Ender-3',
      vendor: 'Creality',
      advertisedNozzleDiameters: [0.4],
      nozzleVariants: [
        {
          variant: '0.4',
          nozzleDiameter: 0.4,
          machinePresetId: 'Creality/machine/Ender-3 0.4 nozzle',
          machinePresetName: 'Ender-3 0.4 nozzle',
        },
      ],
      defaultMaterials: [],
      file: '',
    },
    {
      // No machine preset behind it: unusable, and must not reach the picker.
      id: 'Ghost/No Presets',
      name: 'No Presets',
      vendor: 'Ghost',
      advertisedNozzleDiameters: [0.4],
      nozzleVariants: [],
      defaultMaterials: [],
      file: '',
    },
  ],
};

function filament(name: string, type: string, vendor = 'BBL'): PresetOption {
  return toPresetOption({
    id: `${vendor}/filament/${name}`,
    name,
    type: 'filament',
    vendor,
    file: '',
    chain: [],
    instantiable: true,
    config: { filament_type: [type] },
  });
}

const FILAMENTS = [
  filament('Bambu PLA Basic @BBL H2S', 'PLA'),
  filament('Bambu PETG HF @BBL H2S', 'PETG'),
  filament('Generic PLA @System', 'PLA', 'OrcaFilamentLibrary'),
  filament('Generic TPU @System', 'TPU', 'OrcaFilamentLibrary'),
];

describe('buildCatalog', () => {
  const catalog = buildCatalog(WIRE_CATALOG);

  it('uses the vendor display name, not the directory id', () => {
    expect(catalog.printers.find((p) => p.name === 'Bambu Lab H2S')?.vendorName).toBe('Bambulab');
    expect(catalog.printers.find((p) => p.name === 'Bambu Lab H2S')?.vendorId).toBe('BBL');
  });

  it('takes nozzles from nozzleVariants, not advertisedNozzleDiameters', () => {
    // The H2S advertises 0.2/0.4/0.6/0.8 but only ships two machine presets here.
    // Offering 0.2 would 404 at /catalog/presets.
    const h2s = catalog.printers.find((printer) => printer.name === 'Bambu Lab H2S');
    expect(h2s?.nozzles.map((nozzle) => nozzle.variant)).toEqual(['0.4', '0.8']);
  });

  it('drops printer models with no machine preset', () => {
    expect(catalog.printers.some((printer) => printer.name === 'No Presets')).toBe(false);
    expect(catalog.vendors.some((vendor) => vendor.id === 'Ghost')).toBe(false);
  });

  it('groups printers under their vendor', () => {
    expect(catalog.vendors.map((vendor) => vendor.name)).toEqual(['Bambulab', 'Creality']);
    expect(catalog.vendors[0]?.printers).toHaveLength(2);
  });
});

describe('search', () => {
  const catalog = buildCatalog(WIRE_CATALOG);

  it('matches every term in any order, across vendor and model', () => {
    expect(searchPrinters(catalog.printers, 'x1 carbon').map((p) => p.name)).toEqual([
      'Bambu Lab X1 Carbon',
    ]);
    expect(searchPrinters(catalog.printers, 'carbon bambulab')).toHaveLength(1);
    expect(searchPrinters(catalog.printers, 'ender')).toHaveLength(1);
  });

  it('returns nothing for an empty query, so the vendor drill-down stays in charge', () => {
    expect(searchPrinters(catalog.printers, '   ')).toEqual([]);
  });

  it('filters presets by term and by material chip', () => {
    expect(searchPresets(FILAMENTS, 'pla basic', null).map((p) => p.name)).toEqual([
      'Bambu PLA Basic @BBL H2S',
    ]);
    expect(searchPresets(FILAMENTS, '', 'PLA')).toHaveLength(2);
    expect(searchPresets(FILAMENTS, 'generic', 'PLA').map((p) => p.name)).toEqual([
      'Generic PLA @System',
    ]);
  });
});

describe('filament picker helpers', () => {
  it('orders material chips by how many presets use them', () => {
    expect(materialsOf(FILAMENTS)).toEqual(['PLA', 'PETG', 'TPU']);
  });

  it("pins the printer vendor's own suggestions to the top", () => {
    expect(
      suggestedPresets(FILAMENTS, ['Bambu PLA Basic @BBL H2S', 'Not in this list']).map(
        (preset) => preset.name,
      ),
    ).toEqual(['Bambu PLA Basic @BBL H2S']);
  });

  it('defaults to the first suggested filament', () => {
    expect(defaultFilament(FILAMENTS, ['Bambu PETG HF @BBL H2S'])?.name).toBe(
      'Bambu PETG HF @BBL H2S',
    );
    // No suggestions: anything is better than nothing selected.
    expect(defaultFilament(FILAMENTS, [])?.name).toBe('Bambu PLA Basic @BBL H2S');
  });
});

describe('process presets', () => {
  const processes = ['0.08', '0.16', '0.24'].map((height) =>
    toPresetOption({
      id: `BBL/process/${height}mm`,
      name: `${height}mm Standard`,
      type: 'process',
      vendor: 'BBL',
      file: '',
      chain: [],
      instantiable: true,
      config: { layer_height: height },
    }),
  );

  it('summarises the layer height', () => {
    expect(processes[0]?.detail).toBe('0.08 mm layers');
    expect(processes[0]?.layerHeight).toBe(0.08);
  });

  it('defaults to the preset nearest 0.2 mm, earliest on a tie', () => {
    // 0.16 and 0.24 are equidistant from 0.2; the first wins.
    expect(defaultProcess(processes)?.name).toBe('0.16mm Standard');
    expect(defaultProcess([])).toBeNull();
  });

  it('prefers "Standard" over another preset at the same layer height', () => {
    // A Bambu H2S ships both "0.20mm High Quality" and "0.20mm Standard"; Standard is
    // the everyday one, and it is not first in the alphabetically sorted list.
    const sameHeight = ['0.20mm High Quality', '0.20mm Standard'].map((name) =>
      toPresetOption({
        id: `BBL/process/${name}`,
        name,
        type: 'process',
        vendor: 'BBL',
        file: '',
        chain: [],
        instantiable: true,
        config: { layer_height: '0.2' },
      }),
    );
    expect(defaultProcess(sameHeight)?.name).toBe('0.20mm Standard');
  });
});
