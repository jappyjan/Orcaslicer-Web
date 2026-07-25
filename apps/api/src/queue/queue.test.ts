import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../engine/errors.js';
import { BullMqJobQueue } from './bullmq-queue.js';
import { InProcessJobQueue } from './in-process-queue.js';

/** Runs until cancelled — the shape every well-behaved handler has. */
const idle = async (_payload: { jobId: string }, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

describe('InProcessJobQueue', () => {
  it('never runs more than `concurrency` jobs at once', async () => {
    let running = 0;
    let peak = 0;
    const queue = new InProcessJobQueue({
      concurrency: 2,
      handler: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
      },
    });
    await queue.start();
    await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => queue.enqueue({ jobId: `job-${index}` })),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(peak).toBe(2);
    expect((await queue.stats()).running).toBe(0);
    await queue.close();
  });

  it('runs the whole backlog', async () => {
    const done: string[] = [];
    const queue = new InProcessJobQueue({
      concurrency: 1,
      handler: async (payload) => {
        done.push(payload.jobId);
      },
    });
    await queue.start();
    for (const jobId of ['a', 'b', 'c']) await queue.enqueue({ jobId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toEqual(['a', 'b', 'c']);
    await queue.close();
  });

  it('reports "dequeued" for a job that had not started', async () => {
    const queue = new InProcessJobQueue({ concurrency: 1, handler: idle });
    await queue.start();
    await queue.enqueue({ jobId: 'running' });
    await queue.enqueue({ jobId: 'waiting' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await queue.cancel('waiting')).toBe('dequeued');
    expect((await queue.stats()).queued).toBe(0);
    await queue.close();
  });

  it('signals a running job through its abort signal', async () => {
    let aborted = false;
    const queue = new InProcessJobQueue({
      concurrency: 1,
      handler: async (_payload, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    });
    await queue.start();
    await queue.enqueue({ jobId: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await queue.cancel('live')).toBe('signalled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
    await queue.close();
  });

  it('reports "not-found" for an unknown id', async () => {
    const queue = new InProcessJobQueue({ concurrency: 1, handler: idle });
    await queue.start();
    expect(await queue.cancel('nope')).toBe('not-found');
    await queue.close();
  });

  it('keeps draining after a handler throws', async () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const queue = new InProcessJobQueue({
      concurrency: 1,
      onError: (error) => errors.push(error),
      handler: async (payload) => {
        seen.push(payload.jobId);
        if (payload.jobId === 'boom') throw new Error('handler exploded');
      },
    });
    await queue.start();
    for (const jobId of ['boom', 'after']) await queue.enqueue({ jobId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(['boom', 'after']);
    expect(errors).toHaveLength(1);
    await queue.close();
  });

  it('aborts everything in flight on close', async () => {
    let aborted = false;
    const queue = new InProcessJobQueue({
      concurrency: 1,
      handler: async (_payload, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    });
    await queue.start();
    await queue.enqueue({ jobId: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await queue.close();
    expect(aborted).toBe(true);
  });
});

describe('BullMqJobQueue', () => {
  const queue = new BullMqJobQueue({ handler: idle, concurrency: 4, redisUrl: undefined });

  // ADR 0002: the stub is a real implementation of the interface that throws loudly.
  // A silent no-op would accept jobs and drop them.
  it('throws a clear "not yet implemented" from every operation', async () => {
    await expect(queue.start()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(queue.enqueue({ jobId: 'x' })).rejects.toThrow(/not yet implemented/);
    await expect(queue.cancel('x')).rejects.toThrow(/not yet implemented/);
    await expect(queue.stats()).rejects.toThrow(/Redis/);
  });

  it('still satisfies the port so switching driver is config, not a refactor', () => {
    expect(queue.driver).toBe('bullmq');
    expect(queue.concurrency).toBe(4);
  });

  it('closes without throwing so shutdown paths stay unconditional', async () => {
    await expect(queue.close()).resolves.toBeUndefined();
  });
});
