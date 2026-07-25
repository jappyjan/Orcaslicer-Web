/**
 * Walk `resources/profiles` and index every preset by vendor, type and name.
 *
 * Layout of the tree (OrcaSlicer 2.4.2):
 *
 * ```
 * resources/profiles/
 *   BBL.json                       # vendor index: machine_model_list / machine_list /
 *   BBL/                           #               process_list / filament_list, each
 *     machine/  process/  filament/#               entry {name, sub_path}
 *   OrcaFilamentLibrary.json       # the shared filament library
 *   blacklist.json                 # not a vendor
 * ```
 *
 * `inherits` names a preset **by name inside the same vendor and preset type** — not a
 * path. Files also live in nested sub-directories (`Anycubic/filament/Polymaker/…`),
 * which is why the M0 stopgap's `<same-dir>/<inherits>.json` rule is not good enough:
 * 1939 of 11286 `inherits` edges in 2.4.2 point outside the child's own directory.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { PresetType, UnresolvedPreset } from '../types.js';

/** Keys that describe the inheritance relationship itself and must not survive flattening. */
export const STRUCTURAL_KEYS = ['inherits', 'instantiation'] as const;

/** Vendor whose filaments are shared across vendors in Orca's UI. */
export const SHARED_FILAMENT_VENDOR = 'OrcaFilamentLibrary';

const PRESET_TYPES = new Set<PresetType>(['machine', 'process', 'filament']);

export interface RawPreset {
  id: string;
  name: string;
  type: PresetType;
  vendor: string;
  /** Path relative to `resources/profiles`, always with `/` separators. */
  file: string;
  /** `inherits` value, or `null`. */
  inherits: string | null;
  instantiable: boolean;
  /** Every key except `inherits` / `instantiation`. */
  own: Record<string, unknown>;
  /** True when the vendor index file lists this preset. */
  listed: boolean;
}

export interface RawMachineModel {
  name: string;
  vendor: string;
  file: string;
  raw: Record<string, unknown>;
}

export interface VendorIndex {
  id: string;
  name: string;
  version?: string;
  file: string;
}

export interface LoadedProfiles {
  profilesRoot: string;
  vendors: Map<string, VendorIndex>;
  /** All machine/process/filament presets, keyed by `<vendor>/<type>/<name>`. */
  presets: Map<string, RawPreset>;
  /** `machine_model` entries, keyed by `<vendor>/<name>`. */
  machineModels: Map<string, RawMachineModel>;
  /** Files we could not turn into a preset. Feeds the unresolved report. */
  problems: UnresolvedPreset[];
}

export function presetId(vendor: string, type: string, name: string): string {
  return `${vendor}/${type}/${name}`;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function listJsonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listJsonFiles(full, out);
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

/**
 * Read the whole profile tree.
 *
 * Presets are discovered by walking the directory rather than by trusting the vendor
 * index, then cross-checked against the index in both directions — a file the index
 * forgets is invisible in OrcaSlicer's UI, and an index entry with no file is a broken
 * vendor bundle. Both go into the report.
 */
export function loadProfiles(profilesRoot: string): LoadedProfiles {
  const vendors = new Map<string, VendorIndex>();
  const presets = new Map<string, RawPreset>();
  const machineModels = new Map<string, RawMachineModel>();
  const problems: UnresolvedPreset[] = [];

  const rootEntries = readdirSync(profilesRoot);
  const vendorFiles = rootEntries.filter(
    (e) =>
      e.endsWith('.json') &&
      e !== 'blacklist.json' &&
      !statSync(join(profilesRoot, e)).isDirectory(),
  );

  /** Paths (relative, posix) the vendor index files claim exist. */
  const listedPaths = new Set<string>();
  /** Every json file actually found under a vendor directory, whether or not it loaded. */
  const filesOnDisk = new Set<string>();

  for (const vendorFile of vendorFiles) {
    const vendorId = vendorFile.replace(/\.json$/, '');
    let index: Record<string, unknown>;
    try {
      index = JSON.parse(readFileSync(join(profilesRoot, vendorFile), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch (err) {
      problems.push({
        file: vendorFile,
        vendor: vendorId,
        type: 'vendor',
        name: vendorId,
        reason: 'invalid-json',
        detail: (err as Error).message,
      });
      continue;
    }
    const entry: VendorIndex = {
      id: vendorId,
      name: typeof index.name === 'string' ? index.name : vendorId,
      file: vendorFile,
    };
    if (typeof index.version === 'string') entry.version = index.version;
    vendors.set(vendorId, entry);

    for (const key of ['machine_model_list', 'machine_list', 'process_list', 'filament_list']) {
      const list = index[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const subPath = (item as { sub_path?: unknown }).sub_path;
        if (typeof subPath !== 'string') continue;
        listedPaths.add(toPosix(join(vendorId, subPath)));
      }
    }
  }

  for (const vendorId of vendors.keys()) {
    const vendorDir = join(profilesRoot, vendorId);
    let files: string[];
    try {
      files = listJsonFiles(vendorDir);
    } catch {
      // A vendor index with no directory: nothing to load, and the missing files are
      // reported below by the listed-but-absent check.
      continue;
    }
    for (const full of files) {
      const rel = toPosix(relative(profilesRoot, full));
      filesOnDisk.add(rel);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        problems.push({
          file: rel,
          vendor: vendorId,
          type: 'unknown',
          name: rel,
          reason: 'invalid-json',
          detail: (err as Error).message,
        });
        continue;
      }
      const type = json.type;
      const name = json.name;
      if (typeof type !== 'string') {
        problems.push({
          file: rel,
          vendor: vendorId,
          type: 'unknown',
          name: typeof name === 'string' ? name : rel,
          reason: 'missing-type',
          detail: 'preset json has no "type" key',
        });
        continue;
      }
      if (typeof name !== 'string' || name === '') {
        problems.push({
          file: rel,
          vendor: vendorId,
          type,
          name: rel,
          reason: 'missing-name',
          detail: 'preset json has no "name" key',
        });
        continue;
      }

      if (type === 'machine_model') {
        machineModels.set(`${vendorId}/${name}`, { name, vendor: vendorId, file: rel, raw: json });
        continue;
      }
      if (!PRESET_TYPES.has(type as PresetType)) {
        problems.push({
          file: rel,
          vendor: vendorId,
          type,
          name,
          reason: 'missing-type',
          detail: `unknown preset type "${type}"`,
        });
        continue;
      }

      const id = presetId(vendorId, type, name);
      const listed = listedPaths.has(rel);
      const existing = presets.get(id);
      if (existing) {
        // OrcaSlicer only ever loads presets the vendor index references, so a listed
        // file always beats an unlisted one with the same name (Phrozen ships both
        // `machine/fdm_machine_common.json` and `machine/_fdm_machine_common.json`).
        const loser = existing.listed || !listed ? { rel, name } : { rel: existing.file, name };
        problems.push({
          file: loser.rel,
          vendor: vendorId,
          type,
          name,
          reason: 'duplicate-name',
          detail: `two files define the ${type} preset "${name}"; the vendor-index-listed one wins`,
        });
        if (existing.listed || !listed) continue;
      }

      const own: Record<string, unknown> = { ...json };
      for (const key of STRUCTURAL_KEYS) delete own[key];

      presets.set(id, {
        id,
        name,
        type: type as PresetType,
        vendor: vendorId,
        file: rel,
        inherits:
          typeof json.inherits === 'string' && json.inherits.trim() !== ''
            ? json.inherits.trim()
            : null,
        // Upstream writes the flag as the string "true"/"false"; a missing flag means
        // instantiable for machine_model-less presets in practice, but every preset in
        // 2.4.2 carries it explicitly.
        instantiable: json.instantiation !== 'false' && json.instantiation !== false,
        own,
        listed,
      });
    }
  }

  for (const preset of presets.values()) {
    if (!preset.listed) {
      problems.push({
        file: preset.file,
        vendor: preset.vendor,
        type: preset.type,
        name: preset.name,
        reason: 'not-listed-in-vendor-index',
        detail:
          'file exists on disk but no vendor index entry references it (OrcaSlicer ignores it)',
      });
    }
  }

  for (const listed of listedPaths) {
    if (!filesOnDisk.has(listed)) {
      problems.push({
        file: listed,
        vendor: listed.slice(0, listed.indexOf('/')),
        type: 'unknown',
        name: listed,
        reason: 'listed-but-missing-on-disk',
        detail: 'a vendor index references this sub_path but the file does not exist',
      });
    }
  }

  return { profilesRoot, vendors, presets, machineModels, problems };
}
