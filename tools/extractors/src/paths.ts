/**
 * Where the extractors read from and write to.
 *
 * Everything is keyed by the pinned OrcaSlicer version so a version bump produces a
 * new tree rather than silently overwriting artefacts that no longer match the binary
 * (`ARG ORCA_VERSION` in the Dockerfile is the single source of truth; see
 * `docs/SPEC.md` hard constraint #2).
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pinned OrcaSlicer release. Kept in sync with `ARG ORCA_VERSION` in the Dockerfile and
 * `ORCA_VERSION` in `@orca-web/shared`; `ORCA_VERSION` in the environment (the runtime
 * image sets it) wins so the extractors cannot target a version the binary is not.
 */
export const ORCA_VERSION = process.env.ORCA_VERSION?.trim() || '2.4.2';

/** Repo root, found by walking up from this file until `package.json` with workspaces appears. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'tsconfig.base.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** `/generated` — gitignored, regenerated per OrcaSlicer version (see docs/REPO-LAYOUT.md). */
export function generatedRoot(): string {
  return process.env.ORCA_GENERATED_DIR?.trim() || join(repoRoot(), 'generated');
}

/** `/generated/<version>` — all artefacts for one pinned release. */
export function versionedGeneratedDir(version = ORCA_VERSION): string {
  return join(generatedRoot(), version);
}

/** Cache for verified upstream source files: `/generated/upstream/<version>`. */
export function upstreamCacheDir(version = ORCA_VERSION): string {
  return join(generatedRoot(), 'upstream', version);
}

export function configSchemaPath(version = ORCA_VERSION): string {
  return join(versionedGeneratedDir(version), 'config-schema.json');
}

export function profileCatalogPath(version = ORCA_VERSION): string {
  return join(versionedGeneratedDir(version), 'profile-catalog.json');
}

/** The acceptance artefact: profiles whose inheritance failed to resolve. */
export function catalogReportPath(version = ORCA_VERSION): string {
  return join(versionedGeneratedDir(version), 'profile-catalog.report.json');
}

/**
 * The `resources/profiles` tree of the pinned release.
 *
 * In the runtime image this is `/opt/orcaslicer/resources/profiles` (the Dockerfile
 * keeps `resources/profiles` precisely so this extractor can read it). On a dev host,
 * point `ORCA_RESOURCES` at a copy extracted from the pinned AppImage — see
 * `docs/PROFILE-PIPELINE.md`.
 */
export function profilesRoot(version = ORCA_VERSION): string {
  const fromEnv = process.env.ORCA_RESOURCES?.trim();
  if (fromEnv) return resolve(fromEnv, 'profiles');
  const cached = join(upstreamCacheDir(version), 'resources', 'profiles');
  if (existsSync(cached)) return cached;
  return '/opt/orcaslicer/resources/profiles';
}
