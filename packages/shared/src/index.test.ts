import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORCA_VERSION } from './index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('ORCA_VERSION', () => {
  it('looks like a release version', () => {
    expect(ORCA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // Drift guard: the version is pinned in exactly one place (the Dockerfile ARG,
  // hard constraint #2). This makes sure the constant the app reports never
  // silently disagrees with the binary that is actually shipped.
  it('matches ARG ORCA_VERSION in the Dockerfile', () => {
    const dockerfile = readFileSync(`${repoRoot}Dockerfile`, 'utf8');
    const match = /^ARG ORCA_VERSION=(.+)$/m.exec(dockerfile);
    expect(match?.[1]).toBe(ORCA_VERSION);
  });

  // The golden --help file is captured from the pinned binary and its first line
  // carries the version, so it is a second, independent witness.
  it('matches the version in the golden --help output', () => {
    const golden = readFileSync(`${repoRoot}test/golden/orca-slicer-help.txt`, 'utf8');
    expect(golden.split('\n')[0]).toBe(`OrcaSlicer-${ORCA_VERSION}:`);
  });
});
