#!/usr/bin/env node
/**
 * Build-time entry point for both M2 extractors.
 *
 * ```
 * node dist/cli.js                       # both extractors
 * node dist/cli.js config-schema         # PrintConfig.cpp -> generated/<v>/config-schema.json
 * node dist/cli.js profile-catalog       # resources/profiles -> generated/<v>/profile-catalog.json
 * node dist/cli.js --refresh-checksums   # print the checksums of a new upstream tag
 * ```
 *
 * Environment:
 *   `ORCA_VERSION`       pinned release (default 2.4.2; the runtime image sets it)
 *   `ORCA_RESOURCES`     the slicer's `resources` dir (default /opt/orcaslicer/resources)
 *   `ORCA_GENERATED_DIR` output root (default `<repo>/generated`)
 */

import { buildConfigSchema } from './config-schema/build-config-schema.js';
import { ORCA_VERSION, profilesRoot } from './paths.js';
import { buildProfileCatalog } from './profile-catalog/build-catalog.js';

const EXTRACTOR_TARGETS = ['config-schema', 'profile-catalog'] as const;
type Target = (typeof EXTRACTOR_TARGETS)[number];

async function main(argv: string[]): Promise<number> {
  const refreshChecksums = argv.includes('--refresh-checksums');
  const requested = argv.filter((a) => !a.startsWith('-')) as Target[];
  const unknown = requested.filter((t) => !EXTRACTOR_TARGETS.includes(t));
  if (unknown.length > 0) {
    console.error(`unknown target(s): ${unknown.join(', ')}`);
    console.error(`usage: extract [${EXTRACTOR_TARGETS.join('|')}] [--refresh-checksums]`);
    return 2;
  }
  const targets = requested.length > 0 ? requested : [...EXTRACTOR_TARGETS];
  const log = (msg: string) => console.log(msg);

  console.log(`OrcaSlicer ${ORCA_VERSION}`);
  let failed = false;

  if (targets.includes('config-schema')) {
    const { document } = await buildConfigSchema({ refreshChecksums, log });
    if (document.coverage.missing !== 0) {
      console.error(
        `config-schema: ${document.coverage.missing} option(s) defined upstream but not extracted`,
      );
      failed = true;
    }
    for (const gap of document.gaps) {
      console.warn(`  gap [${gap.kind}] ${gap.key ?? ''} ${gap.detail} (line ${gap.sourceLine})`);
    }
  }

  if (targets.includes('profile-catalog')) {
    console.log(`profiles: ${profilesRoot()}`);
    const { catalog, reportPath } = buildProfileCatalog({ log });
    const { unresolved, structuralProblems } = catalog.report;
    console.log(`  unresolved inheritance: ${unresolved.length} (report: ${reportPath})`);
    console.log(`  structural problems:    ${structuralProblems.length}`);
    for (const item of unresolved) {
      console.error(`  UNRESOLVED ${item.file}: ${item.reason} — ${item.detail}`);
    }
    // An unresolvable chain means some preset cannot be flattened, and a raw preset
    // handed to the CLI slices silently wrong (SPEC "VERIFIED CLI deviations" #1).
    if (unresolved.length > 0) failed = true;
  }

  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  },
);
