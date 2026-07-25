/**
 * What the user has chosen, how it becomes a job descriptor, and how it survives a
 * reload.
 *
 * The drill-down order is printer → nozzle → process + filament, because that is the
 * order the catalog can answer in: `/catalog/presets` needs a model *and* a nozzle
 * before it can say which process and filament presets are valid. Changing the printer
 * or the nozzle therefore invalidates the two below it — {@link withPrinter} and
 * {@link withNozzle} do that rather than leaving a stale preset that would 400 on submit.
 */

import type { JobRequest, ModelSummary, PlateSpec, PresetRef } from '@orca-web/shared';
import type { PresetOption, PrinterOption } from '../api/catalog.ts';

export interface Selection {
  model: ModelSummary | null;
  printer: PrinterOption | null;
  /** `printer_variant`, e.g. `0.4` — the key `/catalog/presets?nozzle=` takes. */
  nozzle: string | null;
  process: PresetOption | null;
  filament: PresetOption | null;
}

export const EMPTY_SELECTION: Selection = {
  model: null,
  printer: null,
  nozzle: null,
  process: null,
  filament: null,
};

export function withPrinter(selection: Selection, printer: PrinterOption): Selection {
  if (selection.printer?.id === printer.id) return selection;
  // A new printer invalidates everything below it in the drill-down. Keeping the old
  // 0.4-nozzle process preset would submit a job the API is right to reject.
  return {
    ...selection,
    printer,
    nozzle: printer.nozzles.length === 1 ? (printer.nozzles[0]?.variant ?? null) : null,
    process: null,
    filament: null,
  };
}

export function withNozzle(selection: Selection, nozzle: string): Selection {
  if (selection.nozzle === nozzle) return selection;
  return { ...selection, nozzle, process: null, filament: null };
}

export function selectedNozzle(
  selection: Selection,
): { variant: string; machinePresetName: string } | null {
  const { printer, nozzle } = selection;
  if (!printer || nozzle === null) return null;
  const variant = printer.nozzles.find((candidate) => candidate.variant === nozzle);
  return variant
    ? { variant: variant.variant, machinePresetName: variant.machinePresetName }
    : null;
}

/** The first thing still missing, as something to put on a disabled button. */
export function missingStep(selection: Selection): string | null {
  if (!selection.model) return 'Choose a model';
  if (!selection.printer) return 'Choose a printer';
  if (selection.nozzle === null) return 'Choose a nozzle';
  if (!selection.process) return 'Choose a quality preset';
  if (!selection.filament) return 'Choose a filament';
  return null;
}

export function isComplete(selection: Selection): boolean {
  return missingStep(selection) === null;
}

/**
 * Build `POST /jobs`'s descriptor.
 *
 * Two things worth stating because they are easy to get wrong:
 *
 *  - the **machine** ref is the nozzle variant's `machinePresetName` plus the *printer
 *    model's* vendor — not the model name, which names a `machine_model`, not a preset.
 *  - the model ref is always `{ source: 'library', id }`. The file was uploaded once via
 *    `POST /models`; re-slicing sends this descriptor and nothing else.
 *
 * M4 came through that seam exactly as planned: pass a {@link PlateSpec} and the plate
 * replaces the single auto-arranged object with one entry per placed instance,
 * `arrange: false` and real `posX`/`posY`/`posZ`. Nothing above this function changed.
 * Without one — no bed loaded, no plater visited — the M3 behaviour still applies and the
 * engine decides where the object goes.
 */
export function buildDescriptor(selection: Selection, plate?: PlateSpec): JobRequest {
  const { model, printer, process, filament } = selection;
  const nozzle = selectedNozzle(selection);
  if (!model || !printer || !nozzle || !process || !filament) {
    throw new Error('the selection is incomplete');
  }

  const machine: PresetRef = {
    kind: 'machine',
    vendor: printer.vendorId,
    name: nozzle.machinePresetName,
  };

  return {
    name: model.filename,
    printer: machine,
    process: { kind: 'process', vendor: process.vendor, name: process.name },
    filaments: [{ kind: 'filament', vendor: filament.vendor, name: filament.name }],
    input: {
      kind: 'plates',
      plates: [
        plate ?? {
          index: 1,
          // No plate to serialise: the engine decides where the object goes. This is also
          // the only printer-agnostic choice: bed centres differ per machine, and
          // `pos_x`/`pos_y` are ignored unless `need_arrange` is false anyway.
          arrange: true,
          objects: [{ model: { source: 'library', id: model.id }, count: 1, filaments: [1] }],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'orca-web.selection.v1';

/**
 * What is worth persisting, and why it is not the whole {@link Selection}: a
 * `PrinterOption` is derived from the catalog, which is re-fetched at start-up anyway,
 * so only the ids are stored and rehydrated against the fresh catalog. The model is
 * stored whole because its `sha256:` id is the thing that makes a reload cost no
 * upload — the point of the content-addressed library.
 */
export interface PersistedSelection {
  modelId?: string;
  modelFilename?: string;
  modelBytes?: number;
  printerId?: string;
  nozzle?: string;
  processName?: string;
  processVendor?: string;
  filamentName?: string;
  filamentVendor?: string;
}

export function toPersisted(selection: Selection): PersistedSelection {
  const persisted: PersistedSelection = {};
  if (selection.model) {
    persisted.modelId = selection.model.id;
    persisted.modelFilename = selection.model.filename;
    persisted.modelBytes = selection.model.bytes;
  }
  if (selection.printer) persisted.printerId = selection.printer.id;
  if (selection.nozzle !== null) persisted.nozzle = selection.nozzle;
  if (selection.process) {
    persisted.processName = selection.process.name;
    persisted.processVendor = selection.process.vendor;
  }
  if (selection.filament) {
    persisted.filamentName = selection.filament.name;
    persisted.filamentVendor = selection.filament.vendor;
  }
  return persisted;
}

export function savePersisted(selection: Selection, storage: Storage | undefined): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(toPersisted(selection)));
  } catch {
    // Private mode, quota, or no storage at all. Losing the last selection is not worth
    // an error message.
  }
}

export function readPersisted(storage: Storage | undefined): PersistedSelection | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as PersistedSelection) : null;
  } catch {
    return null;
  }
}

/** Rebuild the printer/nozzle part of a selection against a freshly fetched catalog. */
export function rehydrate(
  persisted: PersistedSelection | null,
  printers: readonly PrinterOption[],
): Selection {
  if (!persisted) return EMPTY_SELECTION;
  const selection: Selection = { ...EMPTY_SELECTION };

  if (
    persisted.modelId !== undefined &&
    persisted.modelFilename !== undefined &&
    persisted.modelBytes !== undefined
  ) {
    selection.model = {
      id: persisted.modelId,
      filename: persisted.modelFilename,
      bytes: persisted.modelBytes,
      createdAt: '',
      lastUsedAt: '',
    };
  }

  const printer = printers.find((candidate) => candidate.id === persisted.printerId);
  if (!printer) return selection;
  selection.printer = printer;

  const nozzle = printer.nozzles.find((candidate) => candidate.variant === persisted.nozzle);
  if (nozzle) selection.nozzle = nozzle.variant;
  return selection;
}

/**
 * Presets are rehydrated separately: they only exist once the preset list for the chosen
 * printer + nozzle has been fetched, which happens after the catalog.
 */
export function rehydratePresets(
  selection: Selection,
  persisted: PersistedSelection | null,
  processes: readonly PresetOption[],
  filaments: readonly PresetOption[],
): Selection {
  if (!persisted) return selection;
  const next = { ...selection };
  if (!next.process && persisted.processName !== undefined) {
    next.process =
      processes.find(
        (preset) =>
          preset.name === persisted.processName && preset.vendor === persisted.processVendor,
      ) ?? null;
  }
  if (!next.filament && persisted.filamentName !== undefined) {
    next.filament =
      filaments.find(
        (preset) =>
          preset.name === persisted.filamentName && preset.vendor === persisted.filamentVendor,
      ) ?? null;
  }
  return next;
}
