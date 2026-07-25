/**
 * `@orca-web/catalog` — the **read** half of the M2 profile pipeline.
 *
 * `tools/extractors` *generates* `/generated/<orca-version>/{config-schema,profile-catalog}.json`
 * at image-build time; this package *reads* them at runtime. The split exists because
 * `docs/REPO-LAYOUT.md` forbids anything in the request path from importing `tools/*`:
 * those programs parse C++ source and fetch over the network, and neither belongs in a
 * running server. Everything here is pure data access over already-generated JSON — one
 * `readFileSync` at start-up, then in-memory lookups.
 *
 * ```ts
 * import { openProfileCatalog } from '@orca-web/catalog';
 *
 * const catalog = openProfileCatalog({ includeSchema: true });   // once, at start-up
 * catalog.toCatalogResponse({ includeSchema: true });            // GET /catalog body
 * catalog.processPresetsFor({ model: 'Bambu Lab H2S', nozzle: 0.4 });
 * catalog.flattenForSlicer(presetId);                            // -> --load-settings
 * ```
 */

export * from './types.js';

export { presetId, STRUCTURAL_KEYS } from './preset.js';

export {
  ORCA_VERSION,
  catalogReportPath,
  configSchemaPath,
  generatedRoot,
  profileCatalogPath,
  profilesRoot,
  repoRoot,
  upstreamCacheDir,
  versionedGeneratedDir,
} from './paths.js';

export {
  openProfileCatalog,
  ProfileCatalogQuery,
  type CatalogResponse,
  type OpenCatalogOptions,
  type PresetQueryOptions,
  type PrinterSelector,
  type ResolvedPresetView,
} from './catalog-query.js';
