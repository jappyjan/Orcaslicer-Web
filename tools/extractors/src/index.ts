/**
 * `@orca-web/extractors` — the M2 profile pipeline.
 *
 * Two build-time extractors keyed to the pinned OrcaSlicer version, plus a read-only
 * query API over what they generate.
 *
 *  1. **config schema** — parses `src/libslic3r/PrintConfig.cpp` of the pinned tag into
 *     `generated/<version>/config-schema.json`: label, tooltip, enum values *and their
 *     human labels*, min/max, category, units, type, default and the
 *     simple/advanced/expert disclosure level for every option. M6 renders forms from it.
 *     → {@link buildConfigSchema}
 *
 *  2. **profile catalog** — walks `resources/profiles`, resolves every `inherits` chain
 *     and emits `generated/<version>/profile-catalog.json` plus
 *     `profile-catalog.report.json` (the unresolved-inheritance report).
 *     → {@link buildProfileCatalog}
 *
 *  3. **query API** — vendors → printers → nozzle variants → compatible process and
 *     filament presets, with fully resolved values.
 *     → {@link openProfileCatalog}
 *
 * ## Reading the catalog at runtime
 *
 * ```ts
 * import { openProfileCatalog } from '@orca-web/extractors';
 *
 * const catalog = openProfileCatalog({ includeSchema: true });   // once, at start-up
 * catalog.toCatalogResponse({ includeSchema: true });            // GET /catalog body
 * catalog.processPresetsFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
 * catalog.flattenForSlicer(presetId);                            // -> --load-settings
 * ```
 *
 * `openProfileCatalog` and everything it returns are pure data access over the
 * generated JSON: no network, no C++ parsing, no directory walking. The build-time
 * halves (`buildConfigSchema`, `buildProfileCatalog`) are the parts that must never be
 * called from the request path.
 *
 * **`scripts/resolve-profile.mjs` (the M0 stopgap) is superseded by
 * `ProfileCatalogQuery.flattenForSlicer` and by the lower-level {@link mergeChain} /
 * {@link resolveInheritance} that build the catalog.**
 */

export const EXTRACTOR_TARGETS = ['config-schema', 'profile-catalog'] as const;

export type ExtractorTarget = (typeof EXTRACTOR_TARGETS)[number];

export * from './types.js';

export {
  ORCA_VERSION,
  catalogReportPath,
  configSchemaPath,
  generatedRoot,
  profileCatalogPath,
  profilesRoot,
  upstreamCacheDir,
  versionedGeneratedDir,
} from './paths.js';

// --- build time -------------------------------------------------------------
export { buildConfigSchema, type BuildSchemaOptions } from './config-schema/build-config-schema.js';
export {
  parsePrintConfig,
  parseDefineConstants,
  parseMaterialTypes,
  synthesizeMachineLimits,
  synthesizeOverrides,
  type ParseContext,
  type ParsedPrintConfig,
} from './config-schema/parse-print-config.js';
export { buildProfileCatalog, type BuildCatalogOptions } from './profile-catalog/build-catalog.js';
export {
  loadProfiles,
  presetId,
  SHARED_FILAMENT_VENDOR,
  STRUCTURAL_KEYS,
  type LoadedProfiles,
  type RawPreset,
} from './profile-catalog/load-profiles.js';
export {
  findParent,
  mergeChain,
  resolveInheritance,
  type ResolutionResult,
} from './profile-catalog/resolve-inherits.js';
export {
  configLookup,
  evaluateCondition,
  type ConditionResult,
  type ConfigLookup,
} from './profile-catalog/compatibility.js';

// --- read time --------------------------------------------------------------
export {
  openProfileCatalog,
  ProfileCatalogQuery,
  type CatalogResponse,
  type OpenCatalogOptions,
  type PresetQueryOptions,
  type PrinterSelector,
  type ResolvedPresetView,
} from './catalog-query.js';
