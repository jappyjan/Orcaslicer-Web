/**
 * The catalog: 65 vendors, 384 printer models, and a filament list that runs to 392
 * presets / 1.3 MB for a single Bambu H2S 0.4 (because `OrcaFilamentLibrary` is offered
 * for every printer).
 *
 * Three rules follow from those numbers on a 390px screen:
 *
 *  1. **Fetch each list once.** Both endpoints are static per OrcaSlicer version and
 *     ETag-cacheable (`cache-control: public, max-age=3600`), so the browser cache does
 *     the second-visit work; this module keeps the parsed result for the session.
 *  2. **Throw the resolved config away immediately.** A `ResolvedPresetView` carries
 *     ~120 fully resolved keys. 392 of them are megabytes of strings we would otherwise
 *     hold for the life of the tab. We keep the four fields the picker renders; the rest
 *     is garbage as soon as `map` returns. M6 is the milestone that needs `config`, and
 *     it will fetch it per selected preset, not per list.
 *  3. **Filter client-side.** One 1.3 MB fetch beats a request per keystroke on mobile
 *     data, and the server offers no text query anyway.
 */

import { getJson } from './http.ts';

// The wire shapes. Deliberately re-declared rather than imported from `@orca-web/catalog`:
// that package reads files from disk (`docs/REPO-LAYOUT.md` — the web client must not
// depend on it). Only the fields this client uses are described.

interface WireNozzleVariant {
  variant: string;
  nozzleDiameter: number;
  machinePresetId: string;
  machinePresetName: string;
}

interface WirePrinterModel {
  id: string;
  name: string;
  vendor: string;
  family?: string;
  tech?: string;
  advertisedNozzleDiameters: number[];
  nozzleVariants: WireNozzleVariant[];
  defaultMaterials: string[];
  file: string;
}

interface WireVendor {
  id: string;
  name: string;
  printerModels: string[];
}

interface WireCatalog {
  orcaVersion: string;
  generatedAt: string;
  counts: { vendors: number; printerModels: number; presets: number };
  vendors: WireVendor[];
  printerModels: WirePrinterModel[];
}

interface WirePreset {
  id: string;
  name: string;
  type: 'machine' | 'process' | 'filament';
  vendor: string;
  file: string;
  chain: string[];
  instantiable: boolean;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client-side shapes
// ---------------------------------------------------------------------------

export interface NozzleOption {
  /** `printer_variant` — `0.4`, `0.4HF`. NOT a diameter: variants and diameters differ. */
  variant: string;
  diameter: number;
  /** Goes into the job descriptor as the machine `PresetRef.name`. */
  machinePresetName: string;
}

export interface PrinterOption {
  id: string;
  name: string;
  /** Vendor *directory id* (`BBL`) — what the API's `PresetRef.vendor` wants. */
  vendorId: string;
  /** Vendor *display* name (`Bambulab`) — what a person recognises. */
  vendorName: string;
  /**
   * From `nozzleVariants`, never from `advertisedNozzleDiameters`: the model advertises
   * diameters it has no machine preset for, and picking one of those would 404 at
   * `/catalog/presets`.
   */
  nozzles: NozzleOption[];
  /** Filament preset names the vendor suggests — the filament picker's "Suggested". */
  defaultMaterials: string[];
  /** Pre-lowercased "vendor model family" haystack, so search does no work per keystroke. */
  haystack: string;
}

export interface VendorOption {
  id: string;
  name: string;
  printers: PrinterOption[];
}

export interface PresetOption {
  id: string;
  name: string;
  /** Preset vendor directory id; goes straight into the job descriptor. */
  vendor: string;
  /** Process: the layer height. Filament: the material type. */
  detail: string | null;
  /** Filament only: `filament_type[0]`, used for the material chips. */
  material: string | null;
  /** Process only: `layer_height` as a number, for picking a sensible default. */
  layerHeight: number | null;
  haystack: string;
}

export interface Catalog {
  orcaVersion: string;
  vendors: VendorOption[];
  printers: PrinterOption[];
  counts: { vendors: number; printerModels: number; presets: number };
}

/** libslic3r stores most filament values as one-element arrays. */
function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (Array.isArray(value)) {
    const head = value[0];
    if (typeof head === 'string' && head.trim() !== '') return head;
    if (typeof head === 'number') return String(head);
  }
  if (typeof value === 'number') return String(value);
  return null;
}

export function toPrinterOption(model: WirePrinterModel, vendorName: string): PrinterOption {
  return {
    id: model.id,
    name: model.name,
    vendorId: model.vendor,
    vendorName,
    nozzles: model.nozzleVariants.map((variant) => ({
      variant: variant.variant,
      diameter: variant.nozzleDiameter,
      machinePresetName: variant.machinePresetName,
    })),
    defaultMaterials: model.defaultMaterials,
    haystack: `${vendorName} ${model.name} ${model.family ?? ''}`.toLowerCase(),
  };
}

export function buildCatalog(wire: WireCatalog): Catalog {
  const vendorNames = new Map(wire.vendors.map((vendor) => [vendor.id, vendor.name]));
  const printers = wire.printerModels
    .map((model) => toPrinterOption(model, vendorNames.get(model.vendor) ?? model.vendor))
    // A model with no machine preset cannot be sliced with; it would only ever 404.
    .filter((printer) => printer.nozzles.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const byVendor = new Map<string, PrinterOption[]>();
  for (const printer of printers) {
    const list = byVendor.get(printer.vendorId);
    if (list) list.push(printer);
    else byVendor.set(printer.vendorId, [printer]);
  }

  const vendors: VendorOption[] = wire.vendors
    .map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      printers: byVendor.get(vendor.id) ?? [],
    }))
    .filter((vendor) => vendor.printers.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { orcaVersion: wire.orcaVersion, vendors, printers, counts: wire.counts };
}

let catalogPromise: Promise<Catalog> | undefined;

/** Fetched once per session; the browser's HTTP cache handles the next visit. */
export function loadCatalog(): Promise<Catalog> {
  catalogPromise ??= getJson<WireCatalog>('/catalog').then(buildCatalog);
  return catalogPromise;
}

/** Test seam: forget the memoised catalog and preset lists. */
export function resetCatalogCache(): void {
  catalogPromise = undefined;
  presetCache.clear();
}

export function toPresetOption(preset: WirePreset): PresetOption {
  const material = preset.type === 'filament' ? firstString(preset.config.filament_type) : null;
  const rawHeight = preset.type === 'process' ? firstString(preset.config.layer_height) : null;
  const layerHeight = rawHeight === null ? null : Number(rawHeight);
  return {
    id: preset.id,
    name: preset.name,
    vendor: preset.vendor,
    detail:
      preset.type === 'process' ? (rawHeight === null ? null : `${rawHeight} mm layers`) : material,
    material,
    layerHeight: layerHeight !== null && Number.isFinite(layerHeight) ? layerHeight : null,
    haystack: `${preset.name} ${material ?? ''} ${preset.vendor}`.toLowerCase(),
  };
}

/**
 * A defensible first choice so the common path is "model, printer, Slice".
 *
 * Process: the preset closest to a 0.2 mm layer — Orca's own everyday default and the
 * one every vendor ships. Filament: the first entry of the printer model's
 * `defaultMaterials`, i.e. what the printer's own vendor recommends.
 */
export function defaultProcess(presets: readonly PresetOption[]): PresetOption | null {
  if (presets.length === 0) return null;
  let best = presets[0] as PresetOption;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const preset of presets) {
    if (preset.layerHeight === null) continue;
    const distance = Math.abs(preset.layerHeight - 0.2);
    // The epsilon is not decoration: |0.16 - 0.2| and |0.24 - 0.2| differ in the 17th
    // decimal place in IEEE 754, so a bare `<` picks the coarser preset on a tie.
    const closer = distance < bestDistance - 1e-9;
    // A vendor ships several presets at the same height ("0.20mm Standard", "0.20mm
    // High Quality"); "Standard" is the one that is meant to be the everyday choice.
    const equallyCloseButStandard =
      Math.abs(distance - bestDistance) <= 1e-9 &&
      /standard/i.test(preset.name) &&
      !/standard/i.test(best.name);
    if (closer || equallyCloseButStandard) {
      best = preset;
      bestDistance = distance;
    }
  }
  return best;
}

export function defaultFilament(
  presets: readonly PresetOption[],
  defaultMaterials: readonly string[],
): PresetOption | null {
  return suggestedPresets(presets, defaultMaterials)[0] ?? presets[0] ?? null;
}

const presetCache = new Map<string, Promise<PresetOption[]>>();

export function loadPresets(
  type: 'process' | 'filament',
  printer: PrinterOption,
  nozzle: string,
): Promise<PresetOption[]> {
  const key = `${type}|${printer.vendorId}|${printer.name}|${nozzle}`;
  const cached = presetCache.get(key);
  if (cached) return cached;

  const query = new URLSearchParams({
    type,
    model: printer.name,
    vendor: printer.vendorId,
    nozzle,
  });
  const pending = getJson<WirePreset[]>(`/catalog/presets?${query.toString()}`)
    // `map` is what drops `config`; nothing keeps a reference to the parsed response.
    .then((presets) => presets.map(toPresetOption))
    .catch((error: unknown) => {
      presetCache.delete(key);
      throw error;
    });
  presetCache.set(key, pending);
  return pending;
}

/**
 * Filter + rank. Names run to "Bambu PLA Basic @BBL H2S", so a plain substring match on
 * the whole name is the useful behaviour; every term must match, in any order, which is
 * what makes "pla basic" find it.
 */
export function searchPresets(
  presets: readonly PresetOption[],
  query: string,
  material: string | null,
): PresetOption[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return presets.filter((preset) => {
    if (material !== null && preset.material !== material) return false;
    return terms.every((term) => preset.haystack.includes(term));
  });
}

export function searchPrinters(printers: readonly PrinterOption[], query: string): PrinterOption[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return printers.filter((printer) => terms.every((term) => printer.haystack.includes(term)));
}

/** Material chips, most-common first, so the common plastics are reachable with one tap. */
export function materialsOf(presets: readonly PresetOption[]): string[] {
  const counts = new Map<string, number>();
  for (const preset of presets) {
    if (preset.material === null) continue;
    counts.set(preset.material, (counts.get(preset.material) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([material]) => material);
}

/**
 * The vendor's suggested filaments for this printer, in `defaultMaterials` order.
 *
 * This is what makes a 392-entry list usable without typing: the eight presets the
 * printer's own vendor recommends are at the top, and one of them is nearly always the
 * right answer.
 */
export function suggestedPresets(
  presets: readonly PresetOption[],
  defaultMaterials: readonly string[],
): PresetOption[] {
  const byName = new Map(presets.map((preset) => [preset.name, preset]));
  const out: PresetOption[] = [];
  for (const name of defaultMaterials) {
    const preset = byName.get(name);
    if (preset) out.push(preset);
  }
  return out;
}
