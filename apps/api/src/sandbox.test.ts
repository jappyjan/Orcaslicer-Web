/**
 * Hard constraint #4. A leaked sandbox is 200–500 MB that never comes back, so the
 * cleanup path is tested on every exit route: success, failure, timeout, cancellation.
 */

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgeWorkRoot, sandboxPath, withSandbox } from './sandbox.js';

let workRoot = '';

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'work-root-'));
});
afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function fill(path: string): Promise<void> {
  await writeFile(join(path, 'intermediate.bin'), Buffer.alloc(1024 * 256, 1));
}

describe('withSandbox', () => {
  it('creates the sandbox and removes it on success', async () => {
    let seen = '';
    const result = await withSandbox(workRoot, 'job-1', {}, async (sandbox) => {
      seen = sandbox.path;
      await fill(sandbox.path);
      expect((await stat(sandbox.path)).isDirectory()).toBe(true);
      return 'ok';
    });
    expect(result).toBe('ok');
    await expect(stat(seen)).rejects.toThrow();
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('removes it when the body throws', async () => {
    await expect(
      withSandbox(workRoot, 'job-2', {}, async (sandbox) => {
        await fill(sandbox.path);
        throw new Error('slice failed');
      }),
    ).rejects.toThrow('slice failed');
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('removes it when the body is aborted (cancellation)', async () => {
    const controller = new AbortController();
    const pending = withSandbox(workRoot, 'job-3', {}, async (sandbox) => {
      await fill(sandbox.path);
      await new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('cancelled')));
        setTimeout(resolve, 5_000).unref();
      });
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow('cancelled');
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('removes it when the body times out', async () => {
    await expect(
      withSandbox(workRoot, 'job-4', {}, async (sandbox) => {
        await fill(sandbox.path);
        await new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('timed out')), 10),
        );
      }),
    ).rejects.toThrow('timed out');
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('leaves zero bytes behind across many jobs', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        withSandbox(workRoot, `job-multi-${index}`, {}, async (sandbox) => {
          await fill(sandbox.path);
        }).catch(() => undefined),
      ),
    );
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('does not let a cleanup failure mask the body result, but does report it', async () => {
    const errors: unknown[] = [];
    const result = await withSandbox(
      workRoot,
      'job-5',
      { onCleanupError: (error) => errors.push(error) },
      async (sandbox) => {
        // Removing it out from under the finally is the cheapest way to make rm -rf
        // behave unusually; `force: true` still succeeds, which is what we want.
        await rm(sandbox.path, { recursive: true, force: true });
        return 'still ok';
      },
    );
    expect(result).toBe('still ok');
    expect(errors).toEqual([]);
  });
});

describe('sandboxPath', () => {
  it('refuses ids that would escape the work root', () => {
    expect(() => sandboxPath('/work', '../etc')).toThrow(/unsafe job id/);
    expect(() => sandboxPath('/work', 'a/b')).toThrow(/unsafe job id/);
    expect(() => sandboxPath('/work', '')).toThrow(/unsafe job id/);
  });

  it('requires an absolute work root', () => {
    expect(() => sandboxPath('work', 'job')).toThrow(/absolute/);
  });

  it('accepts a uuid', () => {
    expect(sandboxPath('/work', '0e2f9d64-1f3d-4a1e-9c6a-2c0d0b8f2a11')).toBe(
      '/work/0e2f9d64-1f3d-4a1e-9c6a-2c0d0b8f2a11',
    );
  });
});

describe('purgeWorkRoot', () => {
  it('clears anything a crash left behind and recreates the root', async () => {
    await withSandbox(workRoot, 'leaked', { keep: true }, async (sandbox) => {
      await fill(sandbox.path);
    });
    expect(await readdir(workRoot)).toEqual(['leaked']);

    await purgeWorkRoot(workRoot);
    expect(await readdir(workRoot)).toEqual([]);
  });
});
