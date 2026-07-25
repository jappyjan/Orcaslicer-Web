/**
 * The stopgap resolver exists because of SPEC verified deviation #1. These tests pin
 * the behaviour M2's catalog has to keep: a fully flattened preset with no `inherits`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileNotFoundError } from './port.js';
import { StopgapProfileResolver } from './stopgap-resolver.js';

const resolverScript = fileURLToPath(
  new URL('../../../../scripts/resolve-profile.mjs', import.meta.url),
);

let resourcesDir = '';
let resolver: StopgapProfileResolver;

beforeEach(async () => {
  resourcesDir = await mkdtemp(join(tmpdir(), 'profiles-'));
  const machineDir = join(resourcesDir, 'profiles', 'TEST', 'machine');
  await mkdir(machineDir, { recursive: true });
  await writeFile(
    join(machineDir, 'base.json'),
    JSON.stringify({
      name: 'base',
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      printable_height: '250',
      printer_model: 'Test Printer',
    }),
  );
  await writeFile(
    join(machineDir, 'child.json'),
    JSON.stringify({ name: 'child', inherits: 'base', nozzle_diameter: ['0.4'] }),
  );
  resolver = new StopgapProfileResolver({ resourcesDir, resolverScript });
});

afterEach(async () => {
  await rm(resourcesDir, { recursive: true, force: true });
});

describe('StopgapProfileResolver', () => {
  it('flattens the inherits chain and drops the structural key', async () => {
    const profile = await resolver.resolve({ kind: 'machine', vendor: 'TEST', name: 'child' });
    // Inherited from the parent — this is exactly what the CLI would NOT do for us.
    expect(profile.values.printable_height).toBe('250');
    expect(profile.values.printer_model).toBe('Test Printer');
    // The child's own key survives.
    expect(profile.values.nozzle_diameter).toEqual(['0.4']);
    // `inherits` must be gone, or the engine adapter rejects the profile.
    expect(profile.values).not.toHaveProperty('inherits');
    expect(profile.chain).toEqual(['child', 'base']);
  });

  it('caches so repeat resolves cost nothing', async () => {
    const first = resolver.resolve({ kind: 'machine', vendor: 'TEST', name: 'child' });
    const second = resolver.resolve({ kind: 'machine', vendor: 'TEST', name: 'child' });
    expect(first).toBe(second);
    await first;
  });

  it('reports a missing preset as not found', async () => {
    await expect(
      resolver.resolve({ kind: 'machine', vendor: 'TEST', name: 'nope' }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it('refuses names that would escape the profile tree', async () => {
    await expect(
      resolver.resolve({ kind: 'machine', vendor: 'TEST', name: '../../../etc/passwd' }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
    await expect(
      resolver.resolve({ kind: 'machine', vendor: '..', name: 'child' }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it('surfaces a broken chain as a resolution error, not a silent partial result', async () => {
    await writeFile(
      join(resourcesDir, 'profiles', 'TEST', 'machine', 'orphan.json'),
      JSON.stringify({ name: 'orphan', inherits: 'missing-parent' }),
    );
    await expect(
      resolver.resolve({ kind: 'machine', vendor: 'TEST', name: 'orphan' }),
    ).rejects.toThrow(/could not resolve/);
  });
});
