/**
 * `inherits` resolution — the load-bearing piece of M2.
 *
 * ## Why this matters
 *
 * Verified against the pinned 2.4.2 binary in M0 (`docs/SPEC.md`, "VERIFIED CLI
 * deviations" #1): **the OrcaSlicer CLI does not resolve `inherits`, and fails
 * silently when you hand it a raw profile.** `--load-settings` applies only the keys
 * literally present in the file; every other key falls back to the compiled-in
 * `PrintConfig` default. Measured with the stock
 * `BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle.json`:
 *
 * | key               | raw preset gives | flattened chain gives |
 * |-------------------|------------------|-----------------------|
 * | `printable_area`  | 200 x 200        | 256 x 256             |
 * | `printable_height`| 100              | 250                   |
 * | `filament_density`| 0 (`used_g 0.00`)| 1.26 for Bambu PLA    |
 *
 * …and the slicer still exits 0 with plausible-looking G-code. So: **never hand a raw
 * `resources/profiles` file to the CLI.** Flatten first, with {@link resolvePreset}.
 *
 * ## The rule
 *
 * A preset's parent is the preset of the **same type** whose **name** equals
 * `inherits`, **within the same vendor**. It is *not* `<same-dir>/<inherits>.json` —
 * that was the M0 stopgap's rule and it misses 1939 of the 11286 inheritance edges in
 * 2.4.2, because vendors nest presets in sub-directories
 * (`Anycubic/filament/Polymaker/… inherits fdm_filament_pa`, which lives one level up).
 *
 * Child keys override parent keys **wholesale** — there is no per-element array
 * merging, matching how OrcaSlicer's preset system treats a full option value.
 */

import type { UnresolvedPreset } from '@orca-web/catalog';
import {
  presetId,
  SHARED_FILAMENT_VENDOR,
  type LoadedProfiles,
  type RawPreset,
} from './load-profiles.js';

export interface ResolutionResult {
  /** Root-first chain of preset ids, ending with the preset itself. */
  chains: Map<string, string[]>;
  /** Direct parent id per preset (`null` for chain roots). */
  parents: Map<string, string | null>;
  /** Presets whose chain could not be built. THE acceptance artefact. */
  unresolved: UnresolvedPreset[];
}

/**
 * Find the preset a child's `inherits` refers to.
 *
 * Falls back to the shared `OrcaFilamentLibrary` vendor for filaments, mirroring how
 * Orca exposes that library to every vendor. (In 2.4.2 every edge resolves inside its
 * own vendor, so the fallback is defensive rather than load-bearing — but a vendor
 * bundle that leans on the shared library must not silently fail to resolve.)
 */
export function findParent(profiles: LoadedProfiles, child: RawPreset): RawPreset | null {
  if (child.inherits === null) return null;
  const sameVendor = profiles.presets.get(presetId(child.vendor, child.type, child.inherits));
  if (sameVendor) return sameVendor;
  if (child.type === 'filament') {
    const shared = profiles.presets.get(
      presetId(SHARED_FILAMENT_VENDOR, child.type, child.inherits),
    );
    if (shared) return shared;
  }
  return null;
}

/** Build the inheritance chain for every preset, reporting anything that fails. */
export function resolveInheritance(profiles: LoadedProfiles): ResolutionResult {
  const chains = new Map<string, string[]>();
  const parents = new Map<string, string | null>();
  const unresolved: UnresolvedPreset[] = [];
  const failed = new Set<string>();

  const build = (preset: RawPreset, seen: string[]): string[] | null => {
    const cached = chains.get(preset.id);
    if (cached) return cached;
    if (failed.has(preset.id)) return null;

    if (seen.includes(preset.id)) {
      const cycle = [...seen.slice(seen.indexOf(preset.id)), preset.id].join(' -> ');
      for (const id of seen.slice(seen.indexOf(preset.id))) {
        if (failed.has(id)) continue;
        failed.add(id);
        const p = profiles.presets.get(id);
        if (!p) continue;
        unresolved.push({
          file: p.file,
          vendor: p.vendor,
          type: p.type,
          name: p.name,
          reason: 'inherits-cycle',
          detail: `inherits cycle: ${cycle}`,
        });
      }
      return null;
    }

    if (preset.inherits === null) {
      const chain = [preset.id];
      chains.set(preset.id, chain);
      parents.set(preset.id, null);
      return chain;
    }

    const parent = findParent(profiles, preset);
    if (!parent) {
      failed.add(preset.id);
      unresolved.push({
        file: preset.file,
        vendor: preset.vendor,
        type: preset.type,
        name: preset.name,
        reason: 'missing-parent',
        detail: `inherits "${preset.inherits}" but no ${preset.type} preset of that name exists in vendor ${preset.vendor}`,
      });
      return null;
    }

    const parentChain = build(parent, [...seen, preset.id]);
    if (!parentChain) {
      if (!failed.has(preset.id)) {
        failed.add(preset.id);
        unresolved.push({
          file: preset.file,
          vendor: preset.vendor,
          type: preset.type,
          name: preset.name,
          reason: 'missing-parent',
          detail: `parent "${preset.inherits}" (${parent.file}) could not be resolved`,
        });
      }
      return null;
    }

    const chain = [...parentChain, preset.id];
    chains.set(preset.id, chain);
    parents.set(preset.id, parent.id);
    return chain;
  };

  for (const preset of profiles.presets.values()) build(preset, []);
  return { chains, parents, unresolved };
}

/**
 * Flatten a resolved chain into one config object.
 *
 * @param chain root-first preset ids
 * @param own   `id -> the preset's own keys`
 * @param defaults optional compiled-in `PrintConfig` defaults to layer underneath, so
 *   the result is complete rather than merely flattened. Off by default: what the CLI
 *   needs is the flattened preset, and injecting print defaults into a machine profile
 *   would write keys the profile deliberately leaves to the process preset.
 */
export function mergeChain(
  chain: readonly string[],
  own: (id: string) => Record<string, unknown> | undefined,
  defaults?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = defaults ? { ...defaults } : {};
  for (const id of chain) Object.assign(out, own(id) ?? {});
  return out;
}
