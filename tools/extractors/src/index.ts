/**
 * @orca-web/extractors — build-time only. Nothing here runs in the request path.
 *
 * M0 placeholder. M2 fills this in with two extractors, both keyed to the pinned
 * OrcaSlicer version so a version bump regenerates rather than drifts:
 *
 *  1. config-schema: parse `src/libslic3r/PrintConfig.cpp` from the pinned upstream
 *     tag into a JSON schema (labels, tooltips, enums + enum labels, min/max,
 *     category, units, type) that the M6 settings UI renders forms from.
 *  2. profile-catalog: walk `resources/profiles/`, fully resolve `inherits` chains,
 *     and emit a flat catalog of vendors -> printers -> nozzle variants ->
 *     compatible process and filament presets, plus a report of anything that
 *     failed to resolve.
 *
 * `scripts/resolve-profile.mjs` is the throwaway M0 version of (2)'s core merge
 * step; fold it in here and delete it.
 */

export const EXTRACTOR_TARGETS = ['config-schema', 'profile-catalog'] as const;

export type ExtractorTarget = (typeof EXTRACTOR_TARGETS)[number];
