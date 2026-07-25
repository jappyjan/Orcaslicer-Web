/**
 * `; FEATURE: <name>` → `FeatureType`.
 *
 * MEASURED against the pinned 2.4.2 binary (docs/GCODE-PREVIEW-FORMAT.md records the
 * run): the feature marker our slicer emits is
 *
 *     ; FEATURE: Outer wall
 *
 * — leading space, capitalised word, human-readable role name. It is NOT `;TYPE:`, which
 * is what PrusaSlicer and pre-2.x Orca emit and what SPEC's M5 brief assumed. A parser
 * keyed on `;TYPE:` alone would attribute every segment to "unknown" against our own
 * binary, so both spellings are accepted and the legacy role names are mapped onto the
 * same enum.
 *
 * The 2.4.2 name set was taken two ways and cross-checked:
 *  - observed in real output (Outer wall, Inner wall, Overhang wall, Sparse infill,
 *    Internal solid infill, Top surface, Bottom surface, Bridge, Internal Bridge,
 *    Gap infill, Support, Support interface, Custom),
 *  - and read out of the binary's own string table for the roles a 20 mm test print
 *    never reaches (Ironing, Skirt, Brim, Support transition, Prime tower, Mixed).
 */

import { FeatureType, type FeatureTypeValue } from './format.js';

const BY_NAME = new Map<string, FeatureTypeValue>();

function alias(value: FeatureTypeValue, ...names: string[]): void {
  for (const name of names) BY_NAME.set(name.toLowerCase(), value);
}

// Left column: the name OrcaSlicer 2.4.2 writes. Right of it: the legacy `;TYPE:` /
// PrusaSlicer spelling for the same extrusion role, so the parser is not Orca-only.
alias(FeatureType.Custom, 'Custom');
alias(FeatureType.OuterWall, 'Outer wall', 'External perimeter');
alias(FeatureType.InnerWall, 'Inner wall', 'Perimeter');
alias(FeatureType.OverhangWall, 'Overhang wall', 'Overhang perimeter');
alias(FeatureType.SparseInfill, 'Sparse infill', 'Internal infill');
alias(FeatureType.InternalSolidInfill, 'Internal solid infill', 'Solid infill');
alias(FeatureType.TopSurface, 'Top surface', 'Top solid infill');
alias(FeatureType.BottomSurface, 'Bottom surface', 'Bottom solid infill');
alias(FeatureType.Bridge, 'Bridge', 'Bridge infill', 'Overhang infill');
alias(FeatureType.InternalBridge, 'Internal Bridge', 'Internal bridge infill');
alias(FeatureType.GapInfill, 'Gap infill', 'Gap fill', 'Thin wall');
alias(FeatureType.Ironing, 'Ironing');
alias(FeatureType.Skirt, 'Skirt', 'Skirt/Brim');
alias(FeatureType.Brim, 'Brim');
alias(FeatureType.Support, 'Support', 'Support material');
alias(FeatureType.SupportInterface, 'Support interface', 'Support material interface');
alias(FeatureType.SupportTransition, 'Support transition');
alias(FeatureType.PrimeTower, 'Prime tower', 'Wipe tower');
alias(FeatureType.Mixed, 'Mixed', 'Multiple');
alias(FeatureType.Unknown, 'Unknown', 'None');

/**
 * Resolve a marker's payload. An unrecognised name is `Unknown` rather than an error:
 * upstream adds roles between releases and a preview that renders the toolpath in grey
 * is enormously better than one that fails to build.
 */
export function featureFromName(name: string): FeatureTypeValue {
  return BY_NAME.get(name.trim().toLowerCase()) ?? FeatureType.Unknown;
}

/** Whether `featureFromName` would have recognised the name. Drives a parser statistic. */
export function isKnownFeatureName(name: string): boolean {
  return BY_NAME.has(name.trim().toLowerCase());
}
