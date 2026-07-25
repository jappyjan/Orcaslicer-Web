/**
 * STOPGAP profile resolver — replaced by M2's catalog.
 *
 * It shells out to `scripts/resolve-profile.mjs`, the flattener M0 wrote and proved in
 * the smoke test. That script is owned by the profile-pipeline work, so this file
 * *consumes* it and does not reimplement it: the only knowledge duplicated here is the
 * "parent lives next to the child" naming rule, used solely to report the chain in
 * diagnostics.
 *
 * Everything about this file is deliberately narrow so that deleting it is a one-line
 * change in `profiles/create.ts` (see `profiles/port.ts` for the contract M2 implements).
 *
 * What it does NOT do, and M2 must: enumerate presets, express compatibility between
 * printers/nozzles/processes/filaments, validate against the config schema, or report
 * profiles whose inheritance failed to resolve. M1 only ever needs "flatten this one
 * preset I already know the name of".
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PresetKind, PresetRef, ResolvedProfile } from '@orca-web/shared';
import { ProfileNotFoundError, ProfileResolutionError, type ProfileResolver } from './port.js';

const execFileAsync = promisify(execFile);

const KIND_DIRS: Record<PresetKind, string> = {
  machine: 'machine',
  process: 'process',
  filament: 'filament',
};

/** Preset and vendor names come from user input; they must not escape the profile tree. */
const SAFE_NAME = /^[^/\\]+$/;

export interface StopgapProfileResolverConfig {
  /** OrcaSlicer's `resources` directory; `<resources>/profiles/<vendor>/<kind>/<name>.json`. */
  resourcesDir: string;
  /** Absolute path to `scripts/resolve-profile.mjs`. */
  resolverScript: string;
  /** Node executable used to run the script. */
  nodeBinary?: string;
}

export class StopgapProfileResolver implements ProfileResolver {
  readonly id = 'stopgap';
  private readonly config: StopgapProfileResolverConfig;
  /** Profiles are static for a pinned engine version, so one resolve per ref per process. */
  private readonly cache = new Map<string, Promise<ResolvedProfile>>();

  constructor(config: StopgapProfileResolverConfig) {
    this.config = config;
  }

  resolve(ref: PresetRef): Promise<ResolvedProfile> {
    const key = `${ref.vendor}/${ref.kind}/${ref.name}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.resolveUncached(ref).catch((error: unknown) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, pending);
    return pending;
  }

  presetPath(ref: PresetRef): string {
    if (!SAFE_NAME.test(ref.vendor) || !SAFE_NAME.test(ref.name) || ref.name.startsWith('.')) {
      throw new ProfileNotFoundError(ref);
    }
    return join(
      this.config.resourcesDir,
      'profiles',
      ref.vendor,
      KIND_DIRS[ref.kind],
      `${ref.name}.json`,
    );
  }

  private async resolveUncached(ref: PresetRef): Promise<ResolvedProfile> {
    const source = this.presetPath(ref);
    try {
      await readFile(source);
    } catch {
      throw new ProfileNotFoundError(ref);
    }

    const scratch = await mkdtemp(join(tmpdir(), 'orca-profile-'));
    const destination = join(scratch, 'flattened.json');
    try {
      await execFileAsync(this.config.nodeBinary ?? process.execPath, [
        this.config.resolverScript,
        source,
        destination,
      ]);
      const raw = await readFile(destination, 'utf8');
      const values = JSON.parse(raw) as Record<string, unknown>;
      if ('inherits' in values) {
        throw new ProfileResolutionError(ref, 'the flattener left an inherits key behind');
      }
      return { ...ref, values, chain: await this.readChain(source) };
    } catch (error) {
      if (error instanceof ProfileResolutionError) throw error;
      throw new ProfileResolutionError(ref, describe(error), { cause: error });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Names of the presets in the inheritance chain, leaf first. Diagnostic only — the
   * merge itself is the script's job, this only follows `inherits` for the report.
   */
  private async readChain(leaf: string): Promise<string[]> {
    const chain: string[] = [];
    let current = leaf;
    for (let depth = 0; depth < 16; depth += 1) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await readFile(current, 'utf8')) as Record<string, unknown>;
      } catch {
        return chain;
      }
      const name = typeof parsed.name === 'string' ? parsed.name : current;
      chain.push(name);
      const inherits = typeof parsed.inherits === 'string' ? parsed.inherits.trim() : '';
      if (inherits === '') return chain;
      current = join(current, '..', `${inherits}.json`);
    }
    return chain;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr;
    return stderr && stderr.trim() !== '' ? stderr.trim() : error.message;
  }
  return String(error);
}
