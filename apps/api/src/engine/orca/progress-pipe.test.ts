/**
 * Regression tests for the FIFO ordering rule.
 *
 * These use a real `mkfifo` and a real writer process, because the failure this file
 * exists to prevent — opening the read end after the writer, and deadlocking — cannot
 * be reproduced against a mock.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProgressPipe, type RawPipeMessage } from './progress-pipe.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pipe-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Stands in for the slicer: opens the FIFO for writing and emits JSON lines. */
function writeLines(path: string, lines: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', `printf '%s' "$0" > ${JSON.stringify(path)}`, lines.join('')]);
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

describe('ProgressPipe', () => {
  it('receives lines from a writer that starts after the reader (the required order)', async () => {
    const path = join(dir, 'progress.pipe');
    const seen: RawPipeMessage[] = [];
    const pipe = new ProgressPipe(path, (message) => seen.push(message));

    // Step 1+2: reader open first. This must not block — if it did, the writer below
    // would never be started and the test would hang.
    await pipe.open();
    expect((await stat(path)).isFIFO()).toBe(true);

    // Step 3: the "slicer".
    await writeLines(path, [
      '{"plate_index":1,"plate_count":1,"plate_percent":35,"total_percent":34,"message":"Generating infill toolpath"}\n',
      '{"plate_index":1,"plate_count":1,"plate_percent":50,"total_percent":48,"message":"Checking support necessity"}\n',
      '{"plate_index":0,"plate_count":1,"plate_percent":100,"total_percent":100,"message":"All done, Success"}\n',
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await pipe.close();

    expect(seen).toHaveLength(3);
    expect(seen[0]?.message).toBe('Generating infill toolpath');
    expect(seen[2]?.total_percent).toBe(100);
  });

  it('reassembles messages split across chunk boundaries', async () => {
    const path = join(dir, 'split.pipe');
    const seen: RawPipeMessage[] = [];
    const pipe = new ProgressPipe(path, (message) => seen.push(message));
    await pipe.open();

    // One writer, two writes with a gap — exactly what the slicer does. (A FIFO reports
    // EOF as soon as *all* writers close, so a second process would arrive too late;
    // the slicer holds the pipe open for the whole slice.)
    await new Promise<void>((resolve, reject) => {
      const child = spawn('sh', [
        '-c',
        `{ printf '%s' '{"message":"first"}\n{"mes'; sleep 0.1; printf '%s' 'sage":"second"}\n'; } > ${JSON.stringify(path)}`,
      ]);
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pipe.close();

    expect(seen.map((message) => message.message)).toEqual(['first', 'second']);
  });

  it('preserves warnings and tolerates the key being absent', async () => {
    const path = join(dir, 'warn.pipe');
    const seen: RawPipeMessage[] = [];
    const pipe = new ProgressPipe(path, (message) => seen.push(message));
    await pipe.open();

    // MEASURED: 2.4.2 usually omits `warning` entirely rather than sending null.
    await writeLines(path, [
      '{"message":"slicing"}\n',
      '{"message":"supports","warning":"Unsupported overhangs detected"}\n',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pipe.close();

    expect(seen[0]?.warning).toBeUndefined();
    expect(seen[1]?.warning).toBe('Unsupported overhangs detected');
  });

  it('ignores a malformed line instead of failing the slice', async () => {
    const path = join(dir, 'bad.pipe');
    const seen: RawPipeMessage[] = [];
    const malformed: string[] = [];
    const pipe = new ProgressPipe(
      path,
      (message) => seen.push(message),
      (line) => malformed.push(line),
    );
    await pipe.open();

    await writeLines(path, ['not json\n', '{"message":"still fine"}\n']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pipe.close();

    expect(malformed).toEqual(['not json']);
    expect(seen.map((message) => message.message)).toEqual(['still fine']);
  });

  it('deletes the FIFO on close, even if nothing ever wrote to it', async () => {
    const path = join(dir, 'unused.pipe');
    const pipe = new ProgressPipe(path, () => undefined);
    await pipe.open();
    await pipe.close();
    await expect(stat(path)).rejects.toThrow();
    // Closing twice must be safe: the engine's `finally` can run after an early close.
    await expect(pipe.close()).resolves.toBeUndefined();
  });
});
