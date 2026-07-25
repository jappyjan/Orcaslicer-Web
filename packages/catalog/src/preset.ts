/**
 * The two facts about a preset that both halves of the pipeline have to agree on: how a
 * preset is identified, and which of its keys describe the inheritance relationship
 * rather than a setting.
 *
 * They live here, on the read side, because the generated artefact is the contract:
 * `tools/extractors` writes ids in this shape and this package reads them back. Keeping
 * the definition in one place is what stops the writer and the reader drifting apart
 * across an OrcaSlicer version bump.
 */

/**
 * Stable preset id: `<vendor>/<type>/<name>`.
 *
 * `inherits` names a preset **by name, within the same vendor and preset type** — never
 * by path — so vendor + type + name is exactly the identity the catalog is keyed on.
 */
export function presetId(vendor: string, type: string, name: string): string {
  return `${vendor}/${type}/${name}`;
}

/**
 * Keys that describe the inheritance relationship itself and must not survive
 * flattening.
 *
 * A flattened copy that still carried `inherits` would make the CLI look for a parent
 * next to the copy, not find it, and fall back to compiled-in defaults — silently, at
 * exit 0 (docs/SPEC.md "VERIFIED CLI deviations" #1).
 */
export const STRUCTURAL_KEYS = ['inherits', 'instantiation'] as const;
