#!/usr/bin/env node
/**
 * Minimal OrcaSlicer profile-inheritance resolver.
 *
 * WHY THIS EXISTS (M0 stopgap — the real thing is M2's "profile catalog" extractor):
 *
 * The OrcaSlicer CLI does *not* resolve the `inherits` chain of the JSON files
 * shipped in `resources/profiles/`. `--load-settings` / `--load-filaments` apply
 * only the keys literally present in the file you hand it; every other key falls
 * back to the compiled-in PrintConfig default. Verified on 2.4.2: slicing with
 * `BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle.json` produces a resolved
 * `printable_area` of 200x200 (the built-in default) instead of the X1C's
 * 256x256, and `filament_density` of 0 (so slice_info reports used_g="0.00").
 *
 * So anything that hands a stock resource profile to the CLI must flatten the
 * inheritance chain first. This script does exactly that and nothing more.
 *
 * Resolution rule: a preset's parent is `<same-directory>/<inherits>.json`.
 * Child keys override parent keys wholesale (no per-element array merging —
 * that matches how OrcaSlicer's preset system treats a full option value).
 *
 * Usage: node resolve-profile.mjs <input.json> <output.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Keys that describe the inheritance relationship itself and must not survive flattening. */
const STRUCTURAL_KEYS = new Set(['inherits', 'instantiation']);

/**
 * @param {string} file absolute path to a preset JSON
 * @param {string[]} seen chain of already-visited files, for cycle detection
 * @returns {Record<string, unknown>}
 */
function load(file, seen = []) {
  if (seen.includes(file)) {
    throw new Error(`inherits cycle detected: ${[...seen, file].join(' -> ')}`);
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read preset "${file}": ${/** @type {Error} */ (err).message}`, {
      cause: err,
    });
  }

  /** @type {Record<string, unknown>} */
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`preset "${file}" is not valid JSON: ${/** @type {Error} */ (err).message}`, {
      cause: err,
    });
  }

  const parentName = typeof json.inherits === 'string' ? json.inherits.trim() : '';
  if (parentName === '') return json;

  const parentFile = join(dirname(file), `${parentName}.json`);
  const parent = load(parentFile, [...seen, file]);
  return { ...parent, ...json };
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error('usage: resolve-profile.mjs <input.json> <output.json>');
  process.exit(2);
}

const input = resolve(inputArg);
const merged = load(input);

// The flattened preset keeps the leaf's identity but must not point at a parent
// any more, otherwise the CLI would try (and fail) to find it next to the copy.
for (const key of STRUCTURAL_KEYS) delete merged[key];

writeFileSync(resolve(outputArg), `${JSON.stringify(merged, null, 2)}\n`);
