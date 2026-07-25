/**
 * The shipped default queue: in-process, concurrency-limited, not durable.
 *
 * Chosen because the deployment target is one Compose stack on a small VPS and Redis
 * would be a second daemon and a second failure mode for a durability guarantee nobody
 * asked for. The trade is written down in ADR 0002: a restart loses queued work, and
 * the job store marks anything left `queued`/`running` as `interrupted` at boot so no
 * job is silently stuck.
 */

import type { CancelOutcome, JobQueue, QueueHandler, QueuePayload, QueueStats } from './port.js';

export interface InProcessQueueConfig {
  handler: QueueHandler;
  /** Documented in ADR 0002; defaults from CPU count in `config.ts`. */
  concurrency: number;
  onError?: (error: unknown, payload: QueuePayload) => void;
}

export class InProcessJobQueue implements JobQueue {
  readonly driver = 'memory';
  readonly concurrency: number;

  private readonly handler: QueueHandler;
  private readonly onError: ((error: unknown, payload: QueuePayload) => void) | undefined;
  private readonly pending: QueuePayload[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  private started = false;
  private closed = false;

  constructor(config: InProcessQueueConfig) {
    this.handler = config.handler;
    this.concurrency = Math.max(1, Math.trunc(config.concurrency));
    this.onError = config.onError;
  }

  async start(): Promise<void> {
    this.started = true;
    this.pump();
  }

  async enqueue(payload: QueuePayload): Promise<void> {
    if (this.closed) throw new Error('queue is closed');
    this.pending.push(payload);
    this.pump();
  }

  async cancel(jobId: string): Promise<CancelOutcome> {
    const index = this.pending.findIndex((item) => item.jobId === jobId);
    if (index >= 0) {
      this.pending.splice(index, 1);
      return 'dequeued';
    }
    const controller = this.running.get(jobId);
    if (controller) {
      controller.abort();
      return 'signalled';
    }
    return 'not-found';
  }

  async stats(): Promise<QueueStats> {
    return {
      driver: this.driver,
      concurrency: this.concurrency,
      queued: this.pending.length,
      running: this.running.size,
    };
  }

  async close(graceMs = 30_000): Promise<void> {
    this.closed = true;
    this.pending.length = 0;
    for (const controller of this.running.values()) controller.abort();
    // A handler that ignores its abort signal must not be able to hang shutdown
    // forever; the sandbox `finally` still runs when it eventually unwinds.
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, graceMs).unref?.()),
    ]);
  }

  private pump(): void {
    if (!this.started || this.closed) return;
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const payload = this.pending.shift() as QueuePayload;
      const controller = new AbortController();
      this.running.set(payload.jobId, controller);

      const task = this.handler(payload, controller.signal)
        .catch((error: unknown) => {
          // The handler is responsible for recording job failure; anything that escapes
          // it is a bug, and swallowing it silently would stall the queue.
          this.onError?.(error, payload);
        })
        .finally(() => {
          this.running.delete(payload.jobId);
          this.inFlight.delete(task);
          this.pump();
        });
      this.inFlight.add(task);
    }
  }
}
