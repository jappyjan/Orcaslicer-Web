/**
 * Deliverable 3 — the query API over the generated catalog.
 *
 * This module is **pure data access**: it does no network I/O, no C++ parsing and no
 * profile-tree walking. It reads the generated `profile-catalog.json` (and optionally
 * `config-schema.json`) and answers questions about it, resolving `inherits` chains in
 * memory and memoising the result.
 *
 * That purity is why it lives in `packages/catalog` and not in `tools/extractors`:
 * `tools/*` are build-time programs and nothing in the request path may import them
 * (docs/REPO-LAYOUT.md). The extractors *generate* these artefacts; this package
 * *reads* them, and `apps/api` depends only on this half.
 *
 * ## The acceptance question
 *
 * > give me every process preset valid for a **Bambu Lab H2S** with a **0.4 nozzle**,
 * > with fully resolved values
 *
 * ```ts
 * import { openProfileCatalog } from '@orca-web/catalog';
 *
 * const catalog = openProfileCatalog();
 * const presets = catalog.processPresetsFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
 * presets[0].config.layer_height;      // "0.08" — fully resolved, not the leaf's own keys
 * ```
 *
 * ## Handing a preset to the slicer
 *
 * {@link ProfileCatalogQuery.flattenForSlicer} is what the API's `CatalogProfileResolver`
 * calls: it returns the fully flattened preset with the structural keys removed, ready
 * to be written next to the job and passed to `--load-settings` / `--load-filaments`.
 * Never pass a raw `resources/profiles` file — see `docs/SPEC.md`, "VERIFIED CLI
 * deviations" #1.
 */

import { readFileSync } from 'node:fs';

import { configSchemaPath, ORCA_VERSION, profileCatalogPath } from './paths.js';
import { STRUCTURAL_KEYS } from './preset.js';
import type {
  CatalogNozzleVariant,
  CatalogPreset,
  CatalogPrinterModel,
  CatalogReport,
  CatalogVendor,
  ConfigSchemaDocument,
  PresetType,
  ProfileCatalog,
} from './types.js';

/** How a caller names a printer. `vendor` disambiguates models sold under one name. */
export interface PrinterSelector {
  /** Vendor directory id, e.g. `BBL`. Optional; omit to search every vendor. */
  vendor?: string;
  /** Printer model name as it appears in the catalog, e.g. `Bambu Lab H2S`. */
  model: string;
  /**
   * Nozzle diameter in mm (`0.4`) or the raw `printer_variant` (`"0.4"`, `"0.4HF"`).
   * Omit to accept any nozzle variant of the model.
   */
  nozzle?: number | string;
}

export interface PresetQueryOptions {
  /** Include abstract (`instantiation: false`) base presets. Default `false`. */
  includeAbstract?: boolean;
  /**
   * Attach the fully resolved config. Default `true` — the whole point of the catalog
   * is that callers never see a half-resolved preset.
   */
  resolve?: boolean;
  /**
   * Layer the compiled-in `PrintConfig` defaults underneath the resolved chain, so keys
   * the preset chain never mentions are present too. Requires the config schema to have
   * been loaded. Default `false`: what the CLI needs is the flattened preset.
   */
  withDefaults?: boolean;
}

export interface ResolvedPresetView {
  id: string;
  name: string;
  type: PresetType;
  vendor: string;
  /** Path relative to `resources/profiles`, for provenance. */
  file: string;
  /** Root-first inheritance chain that produced {@link config}. */
  chain: string[];
  instantiable: boolean;
  /** Fully resolved key/value config. Empty when `resolve: false` was requested. */
  config: Record<string, unknown>;
}

/** Payload for `GET /catalog`. */
export interface CatalogResponse {
  orcaVersion: string;
  generatedAt: string;
  counts: CatalogReport['counts'];
  vendors: CatalogVendor[];
  printerModels: CatalogPrinterModel[];
  /** Present when the caller asked for it; it roughly doubles the body, so opt-in. */
  configSchema?: ConfigSchemaDocument;
}

function normaliseNozzle(nozzle: number | string | undefined): string | null {
  if (nozzle === undefined) return null;
  return typeof nozzle === 'number' ? String(nozzle) : nozzle.trim();
}

function variantMatches(variant: CatalogNozzleVariant, wanted: string | null): boolean {
  if (wanted === null) return true;
  if (variant.variant === wanted) return true;
  const asNumber = Number(wanted);
  return Number.isFinite(asNumber) && variant.nozzleDiameter === asNumber;
}

/**
 * Queryable view over a generated profile catalog.
 *
 * Construct with {@link openProfileCatalog} (reads the generated file) or directly from
 * an already-parsed {@link ProfileCatalog}, e.g. in tests.
 */
export class ProfileCatalogQuery {
  private readonly resolvedCache = new Map<string, Record<string, unknown>>();
  private defaults: Record<string, unknown> | null = null;

  constructor(
    readonly catalog: ProfileCatalog,
    private readonly schema?: ConfigSchemaDocument,
  ) {}

  // -- inventory ------------------------------------------------------------

  listVendors(): CatalogVendor[] {
    return Object.values(this.catalog.vendors).sort((a, b) => a.name.localeCompare(b.name));
  }

  listPrinterModels(vendorId?: string): CatalogPrinterModel[] {
    return Object.values(this.catalog.printerModels)
      .filter((m) => vendorId === undefined || m.vendor === vendorId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Case-insensitive substring search over printer model names. */
  searchPrinterModels(term: string): CatalogPrinterModel[] {
    const needle = term.trim().toLowerCase();
    return this.listPrinterModels().filter((m) => m.name.toLowerCase().includes(needle));
  }

  /** Exact lookup by catalog id (`BBL/Bambu Lab H2S`) or by model name. */
  getPrinterModel(selector: PrinterSelector | string): CatalogPrinterModel | null {
    if (typeof selector === 'string') {
      const direct = this.catalog.printerModels[selector];
      if (direct) return direct;
      return this.getPrinterModel({ model: selector });
    }
    const matches = this.listPrinterModels(selector.vendor).filter(
      (m) => m.name === selector.model,
    );
    return matches[0] ?? null;
  }

  listNozzleVariants(selector: PrinterSelector | string): CatalogNozzleVariant[] {
    return this.getPrinterModel(selector)?.nozzleVariants ?? [];
  }

  /** The machine preset backing a printer + nozzle selection. */
  findNozzleVariant(selector: PrinterSelector): CatalogNozzleVariant | null {
    const wanted = normaliseNozzle(selector.nozzle);
    const model = this.getPrinterModel(selector);
    if (!model) return null;
    return model.nozzleVariants.find((v) => variantMatches(v, wanted)) ?? null;
  }

  // -- resolution -----------------------------------------------------------

  getPreset(id: string): CatalogPreset | null {
    return this.catalog.presets[id] ?? null;
  }

  /**
   * Merge a preset's inheritance chain into one flat config. Memoised — the same chain
   * is asked for thousands of times when listing presets for a printer.
   */
  resolveConfig(id: string, withDefaults = false): Record<string, unknown> {
    if (withDefaults) return { ...this.printConfigDefaults(), ...this.resolveConfig(id, false) };
    const cached = this.resolvedCache.get(id);
    if (cached) return cached;
    const preset = this.catalog.presets[id];
    if (!preset) return {};
    const out: Record<string, unknown> = {};
    for (const link of preset.chain) Object.assign(out, this.catalog.presets[link]?.own ?? {});
    this.resolvedCache.set(id, out);
    return out;
  }

  /**
   * The generated config schema, when the catalog was opened with it.
   *
   * M6 needs the option definitions on the server too — not to render anything, but to
   * validate the overrides a client sends before they become argv (`apps/api/src/settings`).
   */
  configSchema(): ConfigSchemaDocument | undefined {
    return this.schema;
  }

  /** Compiled-in `PrintConfig` defaults, keyed by option. Requires the config schema. */
  printConfigDefaults(): Record<string, unknown> {
    if (this.defaults) return this.defaults;
    if (!this.schema) {
      throw new Error(
        'withDefaults requires the config schema; open the catalog with { includeSchema: true }',
      );
    }
    const defaults: Record<string, unknown> = {};
    for (const [key, option] of Object.entries(this.schema.options)) defaults[key] = option.default;
    this.defaults = defaults;
    return defaults;
  }

  resolve(id: string, options: PresetQueryOptions = {}): ResolvedPresetView | null {
    const preset = this.catalog.presets[id];
    if (!preset) return null;
    return this.toView(preset, options);
  }

  private toView(preset: CatalogPreset, options: PresetQueryOptions): ResolvedPresetView {
    const resolve = options.resolve !== false;
    return {
      id: preset.id,
      name: preset.name,
      type: preset.type,
      vendor: preset.vendor,
      file: preset.file,
      chain: preset.chain,
      instantiable: preset.instantiable,
      config: resolve ? this.resolveConfig(preset.id, options.withDefaults === true) : {},
    };
  }

  /**
   * The flattened preset to hand to `orca-slicer --load-settings` / `--load-filaments`.
   *
   * `inherits` and `instantiation` are removed: a flattened copy must not point at a
   * parent, because the CLI would look for it next to the copy, not find it, and fall
   * back to compiled-in defaults — silently, at exit 0.
   */
  flattenForSlicer(id: string): Record<string, unknown> {
    const config = { ...this.resolveConfig(id) };
    for (const key of STRUCTURAL_KEYS) delete config[key];
    return config;
  }

  // -- compatibility --------------------------------------------------------

  /** Machine preset ids a process/filament preset is valid for. */
  compatibleMachineIds(presetId: string): string[] {
    const machines = this.catalog.compatibility[presetId]?.machines ?? [];
    return machines
      .map((i) => this.catalog.machinePresetIds[i])
      .filter((id): id is string => id !== undefined);
  }

  /** machine preset id -> preset ids compatible with it. Built once, on first query. */
  private byMachine: Map<string, string[]> | null = null;

  private machineIndex(): Map<string, string[]> {
    if (this.byMachine) return this.byMachine;
    const index = new Map<string, string[]>();
    for (const [presetId, compat] of Object.entries(this.catalog.compatibility)) {
      for (const machine of compat.machines) {
        const machineId = this.catalog.machinePresetIds[machine];
        if (machineId === undefined) continue;
        const list = index.get(machineId);
        if (list) list.push(presetId);
        else index.set(machineId, [presetId]);
      }
    }
    this.byMachine = index;
    return index;
  }

  private presetsForMachine(
    type: PresetType,
    machinePresetId: string,
    options: PresetQueryOptions,
  ): ResolvedPresetView[] {
    const views: ResolvedPresetView[] = [];
    for (const presetId of this.machineIndex().get(machinePresetId) ?? []) {
      const preset = this.catalog.presets[presetId];
      if (!preset || preset.type !== type) continue;
      if (!preset.instantiable && options.includeAbstract !== true) continue;
      views.push(this.toView(preset, options));
    }
    return views.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Every process preset valid for a printer + nozzle, with fully resolved values.
   *
   * Returns `[]` when the printer or nozzle variant does not exist — check with
   * {@link getPrinterModel} / {@link listNozzleVariants} to tell "no presets" apart
   * from "no such printer".
   */
  processPresetsFor(
    selector: PrinterSelector,
    options: PresetQueryOptions = {},
  ): ResolvedPresetView[] {
    const variant = this.findNozzleVariant(selector);
    if (!variant) return [];
    return this.presetsForMachine('process', variant.machinePresetId, options);
  }

  /** Every filament preset valid for a printer + nozzle, with fully resolved values. */
  filamentPresetsFor(
    selector: PrinterSelector,
    options: PresetQueryOptions = {},
  ): ResolvedPresetView[] {
    const variant = this.findNozzleVariant(selector);
    if (!variant) return [];
    return this.presetsForMachine('filament', variant.machinePresetId, options);
  }

  /** The resolved machine preset for a printer + nozzle. */
  machinePresetFor(
    selector: PrinterSelector,
    options: PresetQueryOptions = {},
  ): ResolvedPresetView | null {
    const variant = this.findNozzleVariant(selector);
    if (!variant) return null;
    return this.resolve(variant.machinePresetId, options);
  }

  // -- HTTP payload ---------------------------------------------------------

  /**
   * The `GET /catalog` body: the browsable index (vendors, printer models, nozzle
   * variants), optionally with the config schema M6 renders forms from.
   *
   * Deliberately *not* every preset — there are 11 551 of them. Drill down with
   * {@link processPresetsFor} / {@link filamentPresetsFor} behind query parameters.
   */
  toCatalogResponse(options: { includeSchema?: boolean } = {}): CatalogResponse {
    const body: CatalogResponse = {
      orcaVersion: this.catalog.orcaVersion,
      generatedAt: this.catalog.generatedAt,
      counts: this.catalog.report.counts,
      vendors: this.listVendors(),
      printerModels: this.listPrinterModels(),
    };
    if (options.includeSchema) {
      if (!this.schema) {
        throw new Error(
          'includeSchema requires the config schema; open the catalog with { includeSchema: true }',
        );
      }
      body.configSchema = this.schema;
    }
    return body;
  }
}

export interface OpenCatalogOptions {
  version?: string;
  /** Override the generated catalog path. */
  catalogPath?: string;
  /** Also load `config-schema.json`, enabling `withDefaults` and schema in the response. */
  includeSchema?: boolean;
  schemaPath?: string;
}

/**
 * Load the generated catalog from disk.
 *
 * Cheap enough to call once at API start-up and keep: parsing the ~20 MB catalog takes
 * well under a second and the result is immutable and static per OrcaSlicer version.
 */
export function openProfileCatalog(options: OpenCatalogOptions = {}): ProfileCatalogQuery {
  const version = options.version ?? ORCA_VERSION;
  const path = options.catalogPath ?? profileCatalogPath(version);
  let catalog: ProfileCatalog;
  try {
    catalog = JSON.parse(readFileSync(path, 'utf8')) as ProfileCatalog;
  } catch (err) {
    throw new Error(
      `cannot read the generated profile catalog at ${path}: ${(err as Error).message}. ` +
        `Run \`npm run -w @orca-web/extractors extract\` for OrcaSlicer ${version} first.`,
      { cause: err },
    );
  }
  if (!options.includeSchema) return new ProfileCatalogQuery(catalog);

  const sPath = options.schemaPath ?? configSchemaPath(version);
  let schema: ConfigSchemaDocument;
  try {
    schema = JSON.parse(readFileSync(sPath, 'utf8')) as ConfigSchemaDocument;
  } catch (err) {
    throw new Error(
      `cannot read the generated config schema at ${sPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return new ProfileCatalogQuery(catalog, schema);
}
