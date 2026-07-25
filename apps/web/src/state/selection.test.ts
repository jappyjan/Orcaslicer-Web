import type { ModelSummary } from '@orca-web/shared';
import { describe, expect, it } from 'vitest';
import type { PresetOption, PrinterOption } from '../api/catalog.ts';
import {
  buildDescriptor,
  EMPTY_SELECTION,
  missingStep,
  rehydrate,
  toPersisted,
  withNozzle,
  withPrinter,
  type Selection,
} from './selection.ts';

const PRINTER: PrinterOption = {
  id: 'BBL/Bambu Lab H2S',
  name: 'Bambu Lab H2S',
  vendorId: 'BBL',
  vendorName: 'Bambulab',
  nozzles: [
    { variant: '0.2', diameter: 0.2, machinePresetName: 'Bambu Lab H2S 0.2 nozzle' },
    { variant: '0.4', diameter: 0.4, machinePresetName: 'Bambu Lab H2S 0.4 nozzle' },
  ],
  defaultMaterials: ['Bambu PLA Basic @BBL H2S'],
  haystack: 'bambulab bambu lab h2s',
};

const OTHER: PrinterOption = {
  ...PRINTER,
  id: 'Creality/Ender-3',
  name: 'Ender-3',
  vendorId: 'Creality',
};

const PROCESS: PresetOption = {
  id: 'BBL/process/0.20mm Standard @BBL H2S',
  name: '0.20mm Standard @BBL H2S',
  vendor: 'BBL',
  detail: '0.2 mm layers',
  material: null,
  layerHeight: 0.2,
  haystack: '',
};

const FILAMENT: PresetOption = {
  id: 'BBL/filament/Bambu PLA Basic @BBL H2S',
  name: 'Bambu PLA Basic @BBL H2S',
  vendor: 'BBL',
  detail: 'PLA',
  material: 'PLA',
  layerHeight: null,
  haystack: '',
};

const MODEL: ModelSummary = {
  id: 'sha256:42023c6d90b7d0b307941dfc8761bcf8992c640fcbe56327e933e9708226f78b',
  filename: 'cube20.stl',
  bytes: 684,
  createdAt: '',
  lastUsedAt: '',
};

const COMPLETE: Selection = {
  model: MODEL,
  printer: PRINTER,
  nozzle: '0.4',
  process: PROCESS,
  filament: FILAMENT,
};

describe('selection', () => {
  it('reports the first missing step, in drill-down order', () => {
    expect(missingStep(EMPTY_SELECTION)).toBe('Choose a model');
    expect(missingStep({ ...EMPTY_SELECTION, model: MODEL })).toBe('Choose a printer');
    expect(missingStep({ ...EMPTY_SELECTION, model: MODEL, printer: PRINTER })).toBe(
      'Choose a nozzle',
    );
    expect(missingStep(COMPLETE)).toBeNull();
  });

  it('invalidates the presets below a changed printer', () => {
    // They belong to the old machine; keeping them would submit a job the API is right
    // to reject with PROFILE_INCOMPATIBLE.
    const next = withPrinter(COMPLETE, OTHER);
    expect(next.process).toBeNull();
    expect(next.filament).toBeNull();
    expect(next.nozzle).toBeNull();
    expect(next.model).toEqual(MODEL);
  });

  it('preselects the only nozzle a printer has', () => {
    const single: PrinterOption = { ...PRINTER, nozzles: [PRINTER.nozzles[1] as never] };
    expect(withPrinter(EMPTY_SELECTION, single).nozzle).toBe('0.4');
  });

  it('invalidates the presets below a changed nozzle', () => {
    const next = withNozzle(COMPLETE, '0.2');
    expect(next.process).toBeNull();
    expect(next.filament).toBeNull();
  });

  describe('buildDescriptor', () => {
    it('names the machine preset from the nozzle variant, not the printer model', () => {
      // `Bambu Lab H2S` is a machine_model, not a preset: passing it as the machine ref
      // would 404 in the resolver.
      const descriptor = buildDescriptor(COMPLETE);
      expect(descriptor.printer).toEqual({
        kind: 'machine',
        vendor: 'BBL',
        name: 'Bambu Lab H2S 0.4 nozzle',
      });
      expect(descriptor.process).toEqual({
        kind: 'process',
        vendor: 'BBL',
        name: '0.20mm Standard @BBL H2S',
      });
      expect(descriptor.filaments).toEqual([
        { kind: 'filament', vendor: 'BBL', name: 'Bambu PLA Basic @BBL H2S' },
      ]);
    });

    it('always refers to the model by its content id, so a re-slice needs no upload', () => {
      const descriptor = buildDescriptor(COMPLETE);
      expect(descriptor.input).toEqual({
        kind: 'plates',
        plates: [
          {
            index: 1,
            arrange: true,
            objects: [{ model: { source: 'library', id: MODEL.id }, count: 1, filaments: [1] }],
          },
        ],
      });
    });

    it('refuses an incomplete selection', () => {
      expect(() => buildDescriptor(EMPTY_SELECTION)).toThrow(/incomplete/);
    });
  });

  describe('persistence', () => {
    it('round-trips the printer, nozzle and model through a fresh catalog', () => {
      const persisted = toPersisted(COMPLETE);
      const restored = rehydrate(persisted, [OTHER, PRINTER]);
      expect(restored.printer?.id).toBe(PRINTER.id);
      expect(restored.nozzle).toBe('0.4');
      // The `sha256:` id is what makes a reload cost no upload.
      expect(restored.model?.id).toBe(MODEL.id);
    });

    it('drops a printer that a newer catalog no longer has', () => {
      const restored = rehydrate(toPersisted(COMPLETE), [OTHER]);
      expect(restored.printer).toBeNull();
      expect(restored.nozzle).toBeNull();
      expect(restored.model?.id).toBe(MODEL.id);
    });
  });
});
