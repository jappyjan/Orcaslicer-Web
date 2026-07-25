#!/usr/bin/env node
/**
 * Container-side bootstrap: flatten one preset's `inherits` chain.
 *
 * Replaces the M0 stopgap `scripts/resolve-profile.mjs`, which used the wrong rule
 * (`<same-directory>/<inherits>.json`) and therefore cannot resolve the 1939 of 11286
 * inheritance edges in 2.4.2 whose parent lives in a different directory of the same
 * vendor — e.g. `Anycubic/filament/Polymaker/Fiberon PA6-CF20 @Anycubic Kobra S1.json`
 * inherits `fdm_filament_pa`, which sits one level up in `Anycubic/filament/`.
 *
 * WHY THIS EXISTS AT ALL (see docs/SPEC.md "VERIFIED CLI deviations" #1): the
 * OrcaSlicer CLI does *not* resolve `inherits`. `--load-settings` / `--load-filaments`
 * apply only the keys literally present in the file you hand it; every other key falls
 * back to the compiled-in PrintConfig default. Measured on 2.4.2 with the stock
 * `BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle.json`: `printable_area` 200x200 instead
 * of 256x256, `printable_height` 100 instead of 250, `filament_density` 0 so
 * `used_g="0.00"` — and it still exits 0 with plausible-looking G-code.
 *
 * THE AUTHORITATIVE IMPLEMENTATION IS `tools/extractors`
 * (`ProfileCatalogQuery.flattenForSlicer`, backed by `resolveInheritance`). This file
 * exists only because the M0 runtime image ships the slicer, Node and `scripts/` and
 * nothing else — no `node_modules`, no compiled `dist/`. Once the image builds the
 * Node workspaces (M1+), delete this and call the extractor instead; both apply the
 * same rule, and `tools/extractors/src/profile-catalog/profile-catalog.test.ts` is
 * where that rule is tested.
 *
 * Usage: node flatten-preset.mjs <input.json> <output.json>
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Keys describing the inheritance relationship itself; they must not survive flattening. */
const STRUCTURAL_KEYS = ['inherits', 'instantiation'];

function readJson(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read preset "${file}": ${err.message}`, { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`preset "${file}" is not valid JSON: ${err.message}`, { cause: err });
  }
}

/**
 * Locate the vendor directory containing a preset: `.../profiles/<vendor>/<type>/...`.
 * Returns `{ profilesRoot, vendorDir }`.
 */
function locateVendor(presetFile) {
  let dir = dirname(resolve(presetFile));
  while (dir !== dirname(dir)) {
    const parent = dirname(dir);
    if (basename(parent) === 'profiles') return { profilesRoot: parent, vendorDir: dir };
    dir = parent;
  }
  throw new Error(
    `"${presetFile}" is not inside a resources/profiles tree; cannot resolve its inherits chain`,
  );
}

/**
 * Index every preset of one type in a vendor by its `name`.
 *
 * `inherits` names a preset **by name inside the same vendor and preset type**, not by
 * path, and vendors nest presets in sub-directories — so the whole vendor sub-tree has
 * to be indexed, not just the file's own directory.
 */
function indexVendor(vendorDir, type) {
  const index = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.json')) {
        let json;
        try {
          json = JSON.parse(readFileSync(full, 'utf8'));
        } catch {
          continue; // non-preset json (colour tables, cli_config) — reported by the extractor
        }
        if (json.type === type && typeof json.name === 'string' && !index.has(json.name)) {
          index.set(json.name, json);
        }
      }
    }
  };
  const typeDir = join(vendorDir, type);
  try {
    walk(typeDir);
  } catch (err) {
    throw new Error(`cannot walk "${typeDir}": ${err.message}`, { cause: err });
  }
  return index;
}

function flatten(presetFile) {
  const leaf = readJson(presetFile);
  const type = leaf.type;
  if (typeof type !== 'string') {
    throw new Error(`preset "${presetFile}" has no "type" key`);
  }
  const { vendorDir } = locateVendor(presetFile);
  const index = indexVendor(vendorDir, type);

  const chain = [leaf];
  const seen = [leaf.name];
  let current = leaf;
  while (typeof current.inherits === 'string' && current.inherits.trim() !== '') {
    const parentName = current.inherits.trim();
    if (seen.includes(parentName)) {
      throw new Error(`inherits cycle detected: ${[...seen, parentName].join(' -> ')}`);
    }
    const parent = index.get(parentName);
    if (!parent) {
      throw new Error(
        `preset "${current.name}" inherits "${parentName}", but no ${type} preset of that ` +
          `name exists under ${vendorDir}`,
      );
    }
    seen.push(parentName);
    chain.push(parent);
    current = parent;
  }

  // Root-first, so a child's keys override its parents' wholesale (no per-element
  // array merging — that matches how OrcaSlicer treats a full option value).
  const merged = {};
  for (const preset of chain.reverse()) Object.assign(merged, preset);
  for (const key of STRUCTURAL_KEYS) delete merged[key];
  return merged;
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error('usage: flatten-preset.mjs <input.json> <output.json>');
  process.exit(2);
}
writeFileSync(resolve(outputArg), `${JSON.stringify(flatten(inputArg), null, 2)}\n`);
