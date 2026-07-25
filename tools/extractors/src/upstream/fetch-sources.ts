/**
 * Download + verify + cache the pinned upstream C++ sources.
 *
 * Build-time only. Network access happens here and nowhere else in this package.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { upstreamCacheDir } from '../paths.js';
import { pinnedSourcesFor, sourceUrlsFor, type UpstreamSource } from './sources.js';

export interface FetchedSource {
  path: string;
  sha256: string;
  /** URL the bytes actually came from, or `cache` when the local copy was already good. */
  url: string;
  localPath: string;
  text: string;
}

export function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Read a cached copy if it is present and already matches the expected checksum.
 * Returns `null` when the cache is absent, unreadable or stale.
 */
function readCached(localPath: string, expected: string): Buffer | null {
  try {
    const buf = readFileSync(localPath);
    return sha256Of(buf) === expected ? buf : null;
  } catch {
    return null;
  }
}

async function download(url: string): Promise<Buffer> {
  // Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21);
  // the CLI sets it for its own process so operators behind a proxy do not have to.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface FetchOptions {
  version: string;
  /** Skip the checksum assertion and report what was actually downloaded. Used for version bumps. */
  refreshChecksums?: boolean;
  log?: (msg: string) => void;
}

/** Fetch one pinned source file, preferring the cache, verifying every byte received. */
export async function fetchSource(
  source: UpstreamSource,
  { version, refreshChecksums = false, log = () => {} }: FetchOptions,
): Promise<FetchedSource> {
  const localPath = join(upstreamCacheDir(version), source.path);

  if (!refreshChecksums) {
    const cached = readCached(localPath, source.sha256);
    if (cached) {
      log(`cache hit  ${source.path}`);
      return {
        path: source.path,
        sha256: source.sha256,
        url: 'cache',
        localPath,
        text: cached.toString('utf8'),
      };
    }
  }

  const errors: string[] = [];
  for (const url of sourceUrlsFor(version, source.path)) {
    let buf: Buffer;
    try {
      buf = await download(url);
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
      continue;
    }
    const actual = sha256Of(buf);
    if (!refreshChecksums && actual !== source.sha256) {
      // A mirror serving different bytes than the pin is a hard failure, not a fallback:
      // silently accepting it would let the schema drift away from the pinned binary.
      throw new Error(
        `checksum mismatch for ${source.path} from ${url}\n  expected ${source.sha256}\n  actual   ${actual}`,
      );
    }
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, buf);
    log(`downloaded ${source.path} (${buf.length} bytes, sha256 ${actual}) from ${url}`);
    return { path: source.path, sha256: actual, url, localPath, text: buf.toString('utf8') };
  }

  throw new Error(
    `could not fetch ${source.path} for OrcaSlicer ${version} from any mirror:\n  ${errors.join('\n  ')}`,
  );
}

/** Fetch every pinned source for a version. */
export async function fetchPinnedSources(opts: FetchOptions): Promise<FetchedSource[]> {
  const out: FetchedSource[] = [];
  for (const source of pinnedSourcesFor(opts.version)) {
    out.push(await fetchSource(source, opts));
  }
  return out;
}
