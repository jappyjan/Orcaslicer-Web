/**
 * Pinned upstream C++ sources for the config-schema extractor.
 *
 * The schema is parsed from the *source of the pinned tag*, not hand-maintained, so a
 * version bump regenerates it. The source is not in the Docker image (the image ships
 * the extracted AppImage), so it is fetched and checksum-verified here, in the same
 * spirit as `ARG ORCA_APPIMAGE_SHA256` in the Dockerfile.
 *
 * ## Why a mirror list rather than one URL
 *
 * `github.com` / `codeload.github.com` are the canonical origin and are listed first.
 * Some build environments (including the agent sandbox this was developed in) are
 * behind an egress policy that returns 403 for github.com; jsDelivr serves the same
 * git tag from its CDN and is listed as a fallback. Mirrors are *untrusted*: every
 * download is rejected unless its SHA-256 matches {@link UpstreamSource.sha256}, so the
 * mirror can only affect availability, never content.
 *
 * ## Bumping the version
 *
 *   1. change `ORCA_VERSION`,
 *   2. run `npm run -w @orca-web/extractors extract -- --refresh-checksums`,
 *   3. review the printed checksums, paste them in below, re-run without the flag.
 */

export interface UpstreamSource {
  /** Path inside the OrcaSlicer source tree. Also the path used inside the local cache. */
  path: string;
  /** SHA-256 of the file at the pinned tag. A mismatch is a hard failure. */
  sha256: string;
}

/** Canonical origin first; availability fallbacks after. `{tag}` and `{path}` are substituted. */
export const SOURCE_URL_TEMPLATES = [
  'https://raw.githubusercontent.com/SoftFever/OrcaSlicer/{tag}/{path}',
  'https://cdn.jsdelivr.net/gh/SoftFever/OrcaSlicer@{tag}/{path}',
] as const;

/** The full source tarball, for operators who prefer to fetch once and unpack locally. */
export const SOURCE_TARBALL_URL =
  'https://github.com/SoftFever/OrcaSlicer/archive/refs/tags/{tag}.tar.gz';

/**
 * Checksums per pinned OrcaSlicer version. Verified against the v2.4.2 tag.
 *
 * `PrintConfig.cpp` is the only file the schema extractor needs: it holds both the
 * `def = this->add(...)` option definitions and the `s_keys_map_*` enum tables.
 * `Config.hpp` is pinned as well because the parser depends on one fact from it —
 * `ConfigOptionDef::mode` defaults to `comSimple` — and a silent upstream change to
 * that default would silently mis-tag every option that does not set `mode` explicitly.
 */
export const PINNED_SOURCES: Record<string, UpstreamSource[]> = {
  '2.4.2': [
    {
      path: 'src/libslic3r/PrintConfig.cpp',
      sha256: 'f635101adb6da3ee657656c6fcaa9449871b7c17446b5e2eb59b560a0eb836aa',
    },
    {
      path: 'src/libslic3r/Config.hpp',
      sha256: '455eb2c24a4b25cd8f089d3f020991ab6a1ca4d4d952b10b49fd10b3da5702e4',
    },
    {
      // `#define INITIAL_LAYER_HEIGHT 0.2` etc. — a handful of option defaults are
      // written as these macros rather than as literals.
      path: 'src/libslic3r/PrintConfigConstants.hpp',
      sha256: 'eaeb335f616e52049a9ce52697fb4aaebefa2129ced4718dfc4c9170d9a550ce',
    },
    {
      // `filament_type`'s dropdown is filled from `MaterialType::all()` in a loop, so
      // the choices live here rather than in PrintConfig.cpp.
      path: 'src/libslic3r/MaterialType.cpp',
      sha256: '78daadb9c9e923e83ada34c7485306e3249894eeca2ec1cc49c3dcc143b15a1d',
    },
  ],
};

export function gitTagFor(version: string): string {
  return `v${version}`;
}

export function sourceUrlsFor(version: string, path: string): string[] {
  const tag = gitTagFor(version);
  return SOURCE_URL_TEMPLATES.map((t) =>
    t.replace('{tag}', tag).replace('{path}', path.split('/').map(encodeURIComponent).join('/')),
  );
}

export function pinnedSourcesFor(version: string): UpstreamSource[] {
  const sources = PINNED_SOURCES[version];
  if (!sources) {
    throw new Error(
      `no pinned upstream sources for OrcaSlicer ${version}. Add an entry to PINNED_SOURCES ` +
        `(run the extractor with --refresh-checksums to compute them).`,
    );
  }
  return sources;
}
