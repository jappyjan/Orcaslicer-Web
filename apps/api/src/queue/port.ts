/**
 * The `JobQueue` port. See docs/adr/0002-job-queue-boundary.md.
 *
 * Two deliberate restrictions, both there so the shipped in-process adapter cannot grow
 * an interface a Redis-backed adapter could never satisfy:
 *
 *  1. the work function is supplied at CONSTRUCTION, not per item — a distributed broker
 *     cannot serialise a closure;
 *  2. payloads must be JSON-serialisable — no Buffers, no handles, no callbacks.
 */

export interface QueuePayload {
  jobId: string;
}

export interface QueueStats {
  driver: string;
  concurrency: number;
  queued: number;
  running: number;
}

/**
 * `not-found`  — the queue has never heard of this id, or it already finished.
 * `dequeued`   — it was still waiting and will now never run.
 * `signalled`  — it is running; its abort signal has been raised and it will stop soon.
 */
export type CancelOutcome = 'not-found' | 'dequeued' | 'signalled';

/** The work function. `signal` is raised by `cancel()` and must be honoured promptly. */
export type QueueHandler = (payload: QueuePayload, signal: AbortSignal) => Promise<void>;

export interface JobQueue {
  readonly driver: string;
  readonly concurrency: number;
  /** Begin processing. Enqueuing before `start()` is allowed; the items simply wait. */
  start(): Promise<void>;
  enqueue(payload: QueuePayload): Promise<void>;
  cancel(jobId: string): Promise<CancelOutcome>;
  stats(): Promise<QueueStats>;
  /** Stop accepting work, signal what is running, and wait for it to unwind. */
  close(): Promise<void>;
}
