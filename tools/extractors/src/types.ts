/**
 * Data shapes produced by the M2 extractors.
 *
 * These types describe *generated artefacts* (`/generated/<orca-version>/…`), not
 * runtime state. Everything here is JSON-serialisable so that the generated files
 * round-trip through `JSON.parse` without a revive step.
 */

// ---------------------------------------------------------------------------
// Deliverable 1 — config schema (parsed from PrintConfig.cpp)
// ---------------------------------------------------------------------------

/**
 * Orca's disclosure levels, mirroring `ConfigOptionMode` in `src/libslic3r/Config.hpp`
 * (`comSimple = 0, comAdvanced, comExpert, comDevelop`). M6 groups forms by
 * {@link ConfigOptionSchema.category} and reveals options up to the selected level.
 * `develop` is upstream's hidden/debug tier — do not render it.
 */
export type DisclosureMode = 'simple' | 'advanced' | 'expert' | 'develop';

/** Widget family, derived from the raw libslic3r `coXxx` type token. */
export type ValueKind =
  | 'float'
  | 'int'
  | 'string'
  | 'bool'
  | 'percent'
  | 'floatOrPercent'
  | 'point'
  | 'points'
  | 'enum'
  | 'unknown';

export interface EnumChoice {
  /** The value written into a preset / passed to the CLI. */
  value: string;
  /** Human label as authored upstream (English; `L()` marks it translatable). */
  label: string;
}

export interface ConfigOptionSchema {
  /** Preset key, e.g. `layer_height`. Also usable as a CLI flag (`--layer-height`). */
  key: string;
  /** Raw libslic3r type token, e.g. `coFloat`, `coFloats`, `coEnum`. */
  type: string;
  /** Widget family derived from {@link type}. */
  valueKind: ValueKind;
  /** True for the plural `coXxxs` types — the value is a per-extruder/per-filament vector. */
  isArray: boolean;
  /** True when declared via `add_nullable()` — `nil` is a legal value. */
  nullable: boolean;
  label?: string;
  /** `full_label`, used by upstream where `label` alone is ambiguous. */
  fullLabel?: string;
  tooltip?: string;
  /** Upstream settings-page grouping, e.g. `Quality`, `Strength`, `Support`. */
  category?: string;
  /** `sidetext` upstream: the unit suffix rendered after the field, e.g. `mm`, `mm/s`, `%`. */
  units?: string;
  min?: number;
  max?: number;
  /** `max_literal` upstream: the largest value accepted before it is read as a percentage. */
  maxLiteral?: number;
  mode: DisclosureMode;
  /** Present for `coEnum` / `coEnums`. Order is upstream's UI order. */
  enumChoices?: EnumChoice[];
  /** Compiled-in default. `null` when upstream computed it from an expression we did not evaluate. */
  default: unknown;
  /** Raw C++ expression for the default, kept whenever {@link default} could not be evaluated. */
  defaultExpression?: string;
  /** `gui_type` upstream (e.g. `select_open`, `f_enum_open`, `legend`, `one_string`). */
  guiType?: string;
  guiFlags?: string;
  /** Renders as a multi-line text area (custom G-code blocks). */
  multiline?: boolean;
  readOnly?: boolean;
  /** Set when the option was synthesised by upstream's `filament_extruder_override_keys` loop. */
  derivedFrom?: string;
  /** `PrintConfigDef` member function the option was defined in. */
  section: string;
  /** 1-based line in `PrintConfig.cpp`, for auditing a version bump. */
  sourceLine: number;
}

/** Something the parser saw but could not fully understand. Always reported, never silently dropped. */
export interface SchemaGap {
  kind:
    | 'unparsed-add-call'
    | 'unevaluated-default'
    | 'unknown-enum-keys-map'
    | 'unparsed-assignment'
    | 'enum-values-labels-mismatch';
  key?: string;
  detail: string;
  sourceLine: number;
}

export interface SchemaCoverage {
  /** Distinct keys from literal `this->add("key", …)` calls inside `PrintConfigDef`. */
  definedInPrintConfigDef: number;
  /** Options synthesised by the `filament_extruder_override_keys` loop. */
  definedByOverrideLoop: number;
  /** Options synthesised by the `machine_max_*` axis loop. */
  definedByAxisLoop: number;
  /** Keys upstream defines more than once (the later definition wins, as in libslic3r). */
  redefinedKeys: number;
  /** Total distinct options `PrintConfigDef` defines = the three counts above. */
  definedTotal: number;
  /** Options present in {@link ConfigSchemaDocument.options}. */
  extracted: number;
  /** `definedTotal - extracted`. Must be 0 for the extractor to be considered complete. */
  missing: number;
  /** Options whose compiled-in default could not be evaluated to a JSON value. */
  defaultsUnevaluated: number;
  /** Definitions found outside `PrintConfigDef` (CLI flags, placeholder-parser variables). */
  extractedNonPreset: number;
}

export interface ConfigSchemaDocument {
  /** Pinned OrcaSlicer release these definitions came from. */
  orcaVersion: string;
  /** Upstream source files parsed, with the checksums they were verified against. */
  sources: { path: string; sha256: string; url: string }[];
  generatedAt: string;
  /** Preset options — the ones M6 renders and the CLI accepts as `--flags`. Keyed by option key. */
  options: Record<string, ConfigOptionSchema>;
  /** `--flag` definitions from `CLIActionsConfigDef` / `CLITransformConfigDef` / `CLIMiscConfigDef`. */
  cliOptions: Record<string, ConfigOptionSchema>;
  /** Placeholder-parser variables usable inside custom G-code (read-only, not preset keys). */
  placeholderOptions: Record<string, ConfigOptionSchema>;
  /** Distinct {@link ConfigOptionSchema.category} values, in first-seen order. */
  categories: string[];
  coverage: SchemaCoverage;
  gaps: SchemaGap[];
}

// ---------------------------------------------------------------------------
// Deliverable 2 — profile catalog (walked from resources/profiles)
// ---------------------------------------------------------------------------

export type PresetType = 'machine' | 'process' | 'filament';

/**
 * A preset exactly as it appears on disk: its *own* keys only, plus the resolved
 * identity of its parent. Full values come from {@link ProfileCatalogQuery.resolve},
 * which merges the chain — storing every resolved preset inline would multiply a
 * 20 MB profile tree into hundreds of megabytes of duplicated strings.
 */
export interface CatalogPreset {
  /** Stable id: `<vendor>/<type>/<name>`. */
  id: string;
  name: string;
  type: PresetType;
  vendor: string;
  /** Path relative to `resources/profiles`. */
  file: string;
  /** Parent preset id, or `null` for a chain root. */
  parent: string | null;
  /** Root-first chain of preset ids ending with this preset. Always non-empty. */
  chain: string[];
  /**
   * `instantiation: "true"` upstream — the preset is user-selectable. `false` marks
   * an abstract base that exists only to be inherited from.
   */
  instantiable: boolean;
  /** The preset's own keys (everything except `type`/`name`/`inherits`/`from`/`instantiation`). */
  own: Record<string, unknown>;
}

/** Nozzle variant of a printer model — one selectable machine preset. */
export interface CatalogNozzleVariant {
  /** `printer_variant`, e.g. `0.4`, `0.4HF`. */
  variant: string;
  /** Nozzle diameter in mm, parsed from `nozzle_diameter[0]`. */
  nozzleDiameter: number;
  /** Machine preset id backing this variant. */
  machinePresetId: string;
  machinePresetName: string;
}

export interface CatalogPrinterModel {
  /** Stable id: `<vendor>/<model name>`. */
  id: string;
  /** `machine_model` preset name, e.g. `Bambu Lab H2S`. Matches `printer_model` on machine presets. */
  name: string;
  vendor: string;
  /** `family` upstream, e.g. `BBL-3DP`. */
  family?: string;
  /** `machine_tech`, e.g. `FFF`. */
  tech?: string;
  /** `model_id` upstream (the vendor's internal model code). */
  modelId?: string;
  /** Nozzle diameters advertised on the machine_model (`nozzle_diameter: "0.2;0.4;…"`). */
  advertisedNozzleDiameters: number[];
  /** The machine presets that actually exist for this model, one per nozzle variant. */
  nozzleVariants: CatalogNozzleVariant[];
  /** `default_materials` — filament preset names the vendor suggests. */
  defaultMaterials: string[];
  /** Path of the machine_model json, relative to `resources/profiles`. */
  file: string;
}

export interface CatalogVendor {
  id: string;
  /** Display name from the vendor index (`BBL.json` → `Bambulab`). */
  name: string;
  version?: string;
  printerModels: string[];
  counts: { machine: number; process: number; filament: number };
}

/**
 * Which printers a process/filament preset is valid for, computed from the *resolved*
 * preset (so an inherited `compatible_printers` is honoured).
 */
export interface PresetCompatibility {
  /** Explicit `compatible_printers` list. Empty means "not restricted by name". */
  printers: string[];
  /** Raw `compatible_printers_condition` expression, or `null`. */
  condition: string | null;
  /** Raw `compatible_prints` / `compatible_prints_condition` (filaments only). */
  prints: string[];
  printsCondition: string | null;
  /**
   * Machine presets this preset is valid for, precomputed at build time by evaluating
   * {@link printers} and {@link condition} against the candidate machines.
   *
   * Stored as **indices into {@link ProfileCatalog.machinePresetIds}**, not as strings:
   * there are ~550 000 of these edges in 2.4.2 and spelling out the ids costs 26 MB of
   * artefact. Use `ProfileCatalogQuery.compatibleMachineIds()` to get the ids back.
   */
  machines: number[];
  /** True when {@link condition} could not be evaluated and was treated as "no restriction". */
  conditionUnevaluated: boolean;
}

/** A preset whose `inherits` chain could not be fully resolved. */
export interface UnresolvedPreset {
  file: string;
  vendor: string;
  type: string;
  name: string;
  reason:
    | 'missing-parent'
    | 'inherits-cycle'
    | 'invalid-json'
    | 'missing-type'
    | 'missing-name'
    | 'not-listed-in-vendor-index'
    | 'listed-but-missing-on-disk'
    | 'duplicate-name';
  detail: string;
}

export interface CatalogReport {
  orcaVersion: string;
  generatedAt: string;
  profilesRoot: string;
  counts: {
    vendors: number;
    printerModels: number;
    nozzleVariants: number;
    presets: number;
    machine: number;
    process: number;
    filament: number;
    instantiable: number;
    /** Presets carrying an `inherits` key. */
    withInherits: number;
    /** Presets whose chain resolved cleanly, i.e. every preset minus {@link unresolved}. */
    resolved: number;
    /** Longest `inherits` chain seen (1 = no parent). */
    maxChainDepth: number;
  };
  /**
   * THE acceptance artefact: every profile whose `inherits` chain failed to resolve
   * (`missing-parent` or `inherits-cycle`). A non-empty list means some preset cannot
   * be flattened, and handing it to the CLI would silently produce wrong G-code.
   */
  unresolved: UnresolvedPreset[];
  /**
   * Everything else the walk found wrong: files the vendor index does not reference
   * (OrcaSlicer ignores them too), index entries with no file, duplicate preset names,
   * non-preset json. None of these break inheritance; they are reported so a version
   * bump cannot quietly change the shape of the tree.
   */
  structuralProblems: UnresolvedPreset[];
  /** Compatibility conditions the evaluator could not understand (treated as unrestricted). */
  unevaluatedConditions: { expression: string; presetCount: number }[];
  /**
   * Selectable process/filament presets that match no printer in the tree. Not a
   * resolution failure — upstream ships a few whose `compatible_printers_condition`
   * refers to printers or features no shipped machine profile has.
   */
  presetsWithNoCompatiblePrinter: { id: string; condition: string | null; printers: string[] }[];
}

export interface ProfileCatalog {
  orcaVersion: string;
  generatedAt: string;
  /** Absolute path of the `resources/profiles` tree walked at build time (provenance only). */
  profilesRoot: string;
  vendors: Record<string, CatalogVendor>;
  printerModels: Record<string, CatalogPrinterModel>;
  presets: Record<string, CatalogPreset>;
  /**
   * Every selectable machine preset id, in a stable order. {@link PresetCompatibility}
   * refers to machines by their position in this array.
   */
  machinePresetIds: string[];
  /** Compatibility, keyed by preset id. Only process and filament presets appear. */
  compatibility: Record<string, PresetCompatibility>;
  report: CatalogReport;
}
