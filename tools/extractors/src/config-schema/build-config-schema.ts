/**
 * Deliverable 1 — turn the pinned `PrintConfig.cpp` into the JSON schema M6 renders
 * forms from.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { configSchemaPath, ORCA_VERSION } from '../paths.js';
import { fetchPinnedSources, type FetchedSource } from '../upstream/fetch-sources.js';
import type { ConfigSchemaDocument, SchemaGap } from '../types.js';
import {
  parseDefineConstants,
  parseMaterialTypes,
  parsePrintConfig,
  synthesizeMachineLimits,
  synthesizeOverrides,
} from './parse-print-config.js';

export interface BuildSchemaOptions {
  version?: string;
  outputPath?: string;
  refreshChecksums?: boolean;
  log?: (msg: string) => void;
}

/**
 * The one fact this parser inherits from `Config.hpp`: options that never assign
 * `def->mode` are simple-tier. If upstream ever changes that default, every silent
 * option in the schema would be mis-tagged, so the assertion is load-bearing.
 */
function assertModeDefault(configHpp: FetchedSource | undefined): SchemaGap[] {
  if (!configHpp) return [];
  if (/ConfigOptionMode\s+mode\s*=\s*comSimple\s*;/.test(configHpp.text)) return [];
  return [
    {
      kind: 'unparsed-assignment',
      detail:
        'src/libslic3r/Config.hpp no longer declares `ConfigOptionMode mode = comSimple;` — ' +
        'every option without an explicit def->mode may now be mis-tagged.',
      sourceLine: 0,
    },
  ];
}

export async function buildConfigSchema(
  opts: BuildSchemaOptions = {},
): Promise<{ document: ConfigSchemaDocument; outputPath: string }> {
  const version = opts.version ?? ORCA_VERSION;
  const log = opts.log ?? (() => {});
  const fetchOpts = { version, log, ...(opts.refreshChecksums ? { refreshChecksums: true } : {}) };
  const sources = await fetchPinnedSources(fetchOpts);

  const printConfig = sources.find((s) => s.path.endsWith('PrintConfig.cpp'));
  if (!printConfig) throw new Error('PrintConfig.cpp is not in the pinned source list');

  const constantsSource = sources.find((s) => s.path.endsWith('PrintConfigConstants.hpp'));
  const materialSource = sources.find((s) => s.path.endsWith('MaterialType.cpp'));
  const parsed = parsePrintConfig(printConfig.text, {
    constants: constantsSource ? parseDefineConstants(constantsSource.text) : new Map(),
    materialTypes: materialSource ? parseMaterialTypes(materialSource.text) : [],
  });
  // Order matters: the machine-limits keys must exist before the filament override
  // loop runs, in case a future release adds one of them to the override list.
  const machineLimits = synthesizeMachineLimits(printConfig.text, parsed);
  const synthesized = synthesizeOverrides(parsed);
  const gaps = [
    ...parsed.gaps,
    ...machineLimits.gaps,
    ...synthesized.gaps,
    ...assertModeDefault(sources.find((s) => s.path.endsWith('Config.hpp'))),
  ];

  // `add(...)` calls whose key is a runtime value: the two upstream loops. They are
  // re-created by the synthesize* passes, so they must not be counted as literal defines.
  const nonLiteralAdds = gaps.filter(
    (g) => g.kind === 'unparsed-add-call' && g.detail.startsWith('non-literal option key'),
  ).length;
  const redefinedKeys = gaps.filter(
    (g) => g.kind === 'unparsed-add-call' && g.detail.startsWith('option redefined'),
  ).length;

  const categories: string[] = [];
  for (const option of parsed.options.values()) {
    if (option.category && !categories.includes(option.category)) categories.push(option.category);
  }

  const definedInPrintConfigDef = parsed.addCallsInPrintConfigDef - nonLiteralAdds - redefinedKeys;
  const definedByOverrideLoop = synthesized.added.length;
  const definedByAxisLoop = machineLimits.added.length;
  const definedTotal = definedInPrintConfigDef + definedByOverrideLoop + definedByAxisLoop;
  const extracted = parsed.options.size;
  const document: ConfigSchemaDocument = {
    orcaVersion: version,
    sources: sources.map((s) => ({ path: s.path, sha256: s.sha256, url: s.url })),
    generatedAt: new Date().toISOString(),
    options: Object.fromEntries([...parsed.options].sort(([a], [b]) => a.localeCompare(b))),
    cliOptions: Object.fromEntries([...parsed.cliOptions].sort(([a], [b]) => a.localeCompare(b))),
    placeholderOptions: Object.fromEntries(
      [...parsed.placeholderOptions].sort(([a], [b]) => a.localeCompare(b)),
    ),
    categories,
    coverage: {
      definedInPrintConfigDef,
      definedByOverrideLoop,
      definedByAxisLoop,
      redefinedKeys,
      definedTotal,
      extracted,
      missing: definedTotal - extracted,
      defaultsUnevaluated: [...parsed.options.values()].filter(
        (o) => o.defaultExpression !== undefined,
      ).length,
      extractedNonPreset: parsed.cliOptions.size + parsed.placeholderOptions.size,
    },
    gaps,
  };

  const outputPath = opts.outputPath ?? configSchemaPath(version);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  log(
    `config-schema: ${document.coverage.extracted}/${document.coverage.definedTotal} options, ` +
      `${document.categories.length} categories, ${document.gaps.length} gaps -> ${outputPath}`,
  );
  return { document, outputPath };
}
