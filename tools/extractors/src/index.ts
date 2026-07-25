/**
 * `@orca-web/extractors` — the M2 profile pipeline.
 *
 * Two build-time extractors keyed to the pinned OrcaSlicer version. What they generate
 * is read back by `@orca-web/catalog`.
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
 * ## Reading the catalog at runtime — NOT from here
 *
 * The query API lives in **`@orca-web/catalog`**, not in this package. `tools/*` are
 * build-time programs and nothing in the request path may import them
 * (docs/REPO-LAYOUT.md): this package parses C++ source, walks a 79 MB profile tree and
 * fetches over the network, none of which belongs in a running server.
 *
 * ```ts
 * import { openProfileCatalog } from '@orca-web/catalog';
 * ```
 *
 * The read-side surface is re-exported below purely so build-time code (the CLI, the
 * tests) has one import to reach for. `buildConfigSchema` and `buildProfileCatalog` are
 * the parts that must never be called from the request path.
 *
 * **`scripts/resolve-profile.mjs` and `scripts/flatten-preset.mjs` are both superseded
 * by `ProfileCatalogQuery.flattenForSlicer` and by the lower-level {@link mergeChain} /
 * {@link resolveInheritance} that build the catalog.**
 */

export const EXTRACTOR_TARGETS = ['config-schema', 'profile-catalog'] as const;

export type ExtractorTarget = (typeof EXTRACTOR_TARGETS)[number];

// --- read time (re-exported from @orca-web/catalog) --------------------------
export * from '@orca-web/catalog';

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
  SHARED_FILAMENT_VENDOR,
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
