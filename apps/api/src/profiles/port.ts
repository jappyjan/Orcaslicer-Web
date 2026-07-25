/**
 * The `ProfileResolver` port — THE SEAM M2 REPLACES.
 *
 * Why it exists: the CLI does not resolve preset `inherits` chains and fails *silently*
 * when handed a raw preset (SPEC verified deviation #1 — 200×200 bed instead of
 * 256×256, `filament_density` 0 so the reported mass is 0.00 g, and exit 0 throughout).
 * So something must flatten presets before they reach an engine, and M1 needs that
 * something before M2's profile catalog exists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  M2: to replace the stopgap, implement THIS interface and register it in
 *  `profiles/create.ts` under a new `PROFILE_RESOLVER` value. Nothing else changes:
 *  no call site outside `profiles/` constructs a resolver, and the only method the
 *  API uses is `resolve()`.
 *
 *    class CatalogProfileResolver implements ProfileResolver {
 *      readonly id = 'catalog';
 *      resolve(ref: PresetRef): Promise<ResolvedProfile> { ... }
 *    }
 *
 *  The contract the implementation must honour:
 *   - `values` is fully flattened: every key the preset chain sets is present, and
 *     `inherits` is absent. The engine adapter asserts this and refuses to slice
 *     otherwise.
 *   - a missing preset throws `ProfileNotFoundError`; anything else that goes wrong
 *     throws `ProfileResolutionError`. Both map to clean HTTP 4xx/5xx responses.
 *   - `resolve()` may be called concurrently for the same ref and is expected to be
 *     cheap on repeat calls (profiles are static for a pinned engine version).
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { PresetRef, ResolvedProfile } from '@orca-web/shared';

export interface ProfileResolver {
  /** Identifies the implementation in logs and in `GET /healthz`. */
  readonly id: string;
  resolve(ref: PresetRef): Promise<ResolvedProfile>;
}

export class ProfileNotFoundError extends Error {
  readonly ref: PresetRef;
  constructor(ref: PresetRef) {
    super(`no ${ref.kind} preset named "${ref.name}" for vendor "${ref.vendor}"`);
    this.name = 'ProfileNotFoundError';
    this.ref = ref;
  }
}

export class ProfileResolutionError extends Error {
  readonly ref: PresetRef;
  constructor(ref: PresetRef, message: string, options?: { cause?: unknown }) {
    super(`could not resolve ${ref.kind} preset "${ref.name}": ${message}`, options);
    this.name = 'ProfileResolutionError';
    this.ref = ref;
  }
}
