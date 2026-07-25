#!/usr/bin/env node
/**
 * Container-side entry point: flatten one preset out of the generated catalog.
 *
 *   node packages/catalog/dist/flatten-cli.js "BBL/machine/Bambu Lab X1 Carbon 0.4 nozzle" out.json
 *   node packages/catalog/dist/flatten-cli.js BBL machine "Bambu Lab X1 Carbon 0.4 nozzle" out.json
 *
 * This replaces `scripts/resolve-profile.mjs` (M0) and `scripts/flatten-preset.mjs`
 * (M2's interim), both of which re-implemented inheritance resolution because the image
 * shipped no `node_modules` and no compiled `dist/`. The image now builds the Node
 * workspaces and bakes the generated catalog in, so the smoke test can call the same
 * code path the API uses — one resolver, tested once.
 *
 * WHY FLATTENING IS MANDATORY (docs/SPEC.md, "VERIFIED CLI deviations" #1): the CLI does
 * not resolve `inherits`. `--load-settings` / `--load-filaments` apply only the keys
 * literally present in the file handed to them; everything else silently falls back to
 * the compiled-in `PrintConfig` default — a 200×200 bed instead of 256×256 and
 * `filament_density` 0, so `used_g="0.00"`, at exit 0.
 */

import { writeFileSync } from 'node:fs';

import { openProfileCatalog } from './catalog-query.js';
import { presetId } from './preset.js';

function usage(): never {
  console.error('usage: flatten-cli.js <vendor/type/name | vendor type name> <output.json>');
  process.exit(2);
}

function main(argv: string[]): void {
  const output = argv.at(-1);
  const idParts = argv.slice(0, -1);
  if (output === undefined || idParts.length === 0) usage();

  const id =
    idParts.length === 1
      ? (idParts[0] as string)
      : presetId(...(idParts as [string, string, string]));

  const catalog = openProfileCatalog();
  const preset = catalog.getPreset(id);
  if (!preset) {
    console.error(
      `no preset "${id}" in the generated catalog for OrcaSlicer ${catalog.catalog.orcaVersion}`,
    );
    process.exit(1);
  }

  const values = catalog.flattenForSlicer(id);
  // Belt and braces: the whole point of this program is that what it writes carries no
  // inheritance. Assert it rather than trusting the artefact.
  if ('inherits' in values) {
    console.error(`flattened "${id}" still carries an inherits key — the catalog is corrupt`);
    process.exit(1);
  }
  writeFileSync(output, `${JSON.stringify(values, null, 2)}\n`);
  console.log(
    `${id}: ${Object.keys(values).length} resolved keys (chain: ${preset.chain.join(' <- ')})`,
  );
}

main(process.argv.slice(2));
