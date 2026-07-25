/**
 * BullMQ / Redis adapter — STUBBED, selected with `QUEUE_DRIVER=bullmq`.
 *
 * It is a real implementation of `JobQueue` that throws `NotImplementedError` from
 * every method, deliberately: a misconfigured deployment must fail loudly at boot
 * rather than accept jobs and drop them on the floor.
 *
 * To finish it (ADR 0002 — this is a file, not a refactor):
 *  - add `bullmq` + `ioredis` and connect to `config.redisUrl`;
 *  - `enqueue` → `queue.add(JOB_NAME, payload, { jobId, removeOnComplete })`;
 *  - `start`   → a `Worker` bound to the handler with `concurrency`;
 *  - `cancel`  → remove the waiting job, or publish a cancellation message the worker
 *    turns into an `AbortController.abort()` (BullMQ has no built-in mid-job abort);
 *  - the sandbox lifecycle and the wall-clock timeout stay in `jobs/job-service.ts` and
 *    need no changes, because they never knew which queue they were running under.
 *
 * Note for whoever does it: the artefact store and `/work` are node-local, so a real
 * multi-worker deployment also needs shared storage or worker-affinity for
 * `GET /jobs/:id/artifacts/:name`. That is a deployment decision, not a queue one.
 */

import { NotImplementedError } from '../engine/errors.js';
import type { CancelOutcome, JobQueue, QueueHandler, QueuePayload, QueueStats } from './port.js';

export interface BullMqQueueConfig {
  handler: QueueHandler;
  concurrency: number;
  redisUrl: string | undefined;
}

const MISSING = 'a Redis connection, a BullMQ Worker, and mid-job cancellation';

export class BullMqJobQueue implements JobQueue {
  readonly driver = 'bullmq';
  readonly concurrency: number;

  constructor(config: BullMqQueueConfig) {
    this.concurrency = config.concurrency;
    // The handler and URL are accepted so the constructor signature is already the real
    // one; they are intentionally unused until the adapter is implemented.
    void config.handler;
    void config.redisUrl;
  }

  async start(): Promise<void> {
    throw new NotImplementedError('The BullMQ/Redis queue adapter', MISSING);
  }

  async enqueue(_payload: QueuePayload): Promise<void> {
    throw new NotImplementedError('The BullMQ/Redis queue adapter', MISSING);
  }

  async cancel(_jobId: string): Promise<CancelOutcome> {
    throw new NotImplementedError('The BullMQ/Redis queue adapter', MISSING);
  }

  async stats(): Promise<QueueStats> {
    throw new NotImplementedError('The BullMQ/Redis queue adapter', MISSING);
  }

  async close(): Promise<void> {
    // Closing a queue that never started must not throw: shutdown paths run this
    // unconditionally.
  }
}

export function createBullMqQueue(config: BullMqQueueConfig): JobQueue {
  return new BullMqJobQueue(config);
}
