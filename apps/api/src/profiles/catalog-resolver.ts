/**
 * `ProfileResolver` backed by M2's generated profile catalog — the real implementation
 * the port was designed for (see `profiles/port.ts`).
 *
 * It replaces `StopgapProfileResolver`, which shelled out to a script that resolved
 * `inherits` as `<same-directory>/<inherits>.json`. That rule is wrong: `inherits` names
 * a preset **by name within the same vendor and preset type**, and 1939 of the 11 286
 * inheritance edges in 2.4.2 point outside the child's own directory — so ~17 % of edges
 * silently resolved to the wrong parent, or to none. The catalog resolves every chain at
 * build time and reports the ones that fail, which is what makes "fully flattened" a
 * checked property rather than a hope.
 *
 * Why any of this exists: `docs/SPEC.md`, "VERIFIED CLI deviations" #1 — the CLI applies
 * only the keys literally present in the file handed to `--load-settings`, falls back to
 * compiled-in defaults for everything else, and still exits 0. A raw preset gives a
 * 200×200 bed and `filament_density` 0, so the reported mass is `0.00 g`.
 * `engine/orca/orca-cli-engine.ts` keeps a defensive assertion for exactly that symptom.
 */

import { presetId, type ProfileCatalogQuery } from '@orca-web/catalog';
import type { PresetRef, ResolvedProfile } from '@orca-web/shared';
import { ProfileNotFoundError, ProfileResolutionError, type ProfileResolver } from './port.js';

export class CatalogProfileResolver implements ProfileResolver {
  readonly id = 'catalog';

  /**
   * Profiles are static for a pinned engine version, so a resolved profile is computed
   * once per process and shared. The values are frozen because they are handed to the
   * engine adapter, which only ever serialises them.
   */
  private readonly cache = new Map<string, ResolvedProfile>();

  constructor(private readonly catalog: ProfileCatalogQuery) {}

  /**
   * Concurrency-safe by construction: every step below is synchronous, so two callers
   * racing on the same ref cannot interleave and cannot observe a half-built entry. The
   * method stays `async` because the port is engine-agnostic — a resolver backed by a
   * database would need it.
   */
  async resolve(ref: PresetRef): Promise<ResolvedProfile> {
    const id = presetId(ref.vendor, ref.kind, ref.name);
    const cached = this.cache.get(id);
    if (cached) return cached;

    const preset = this.catalog.getPreset(id);
    if (!preset) throw new ProfileNotFoundError(ref);

    let values: Record<string, unknown>;
    try {
      values = this.catalog.flattenForSlicer(id);
    } catch (error) {
      throw new ProfileResolutionError(ref, describe(error), { cause: error });
    }

    if ('inherits' in values) {
      // Unreachable unless the artefact itself is corrupt: `flattenForSlicer` strips the
      // structural keys. Cheap to check, and the failure it guards against is silent.
      throw new ProfileResolutionError(ref, 'the flattened preset still carries an inherits key');
    }
    if (Object.keys(values).length === 0) {
      throw new ProfileResolutionError(ref, 'the preset resolved to no settings at all');
    }

    const resolved: ResolvedProfile = {
      ...ref,
      values: Object.freeze(values),
      // The catalog stores chains root-first as ids; the port documents them leaf-first
      // as names, because that is what reads well in a diagnostic.
      chain: [...preset.chain].reverse().map((link) => this.catalog.getPreset(link)?.name ?? link),
    };
    this.cache.set(id, resolved);
    return resolved;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
