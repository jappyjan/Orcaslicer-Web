# ADR 0002 — The `JobQueue` boundary

- **Status:** accepted
- **Date:** M1
- **Deciders:** M1 (slice service)

## Context

Slicing is CPU-bound and long (seconds to minutes) and a single job can hold
200–500 MB of intermediates. Requests must not slice inline: a phone on a flaky
connection would tie up a worker for minutes and lose the result on disconnect.

The deployment target is one Docker Compose stack on a small VPS, single-tenant.
Requiring Redis for that is a second daemon, a second failure mode and a second thing
to back up, to buy a durability guarantee nobody has asked for. But a team that
outgrows one box needs exactly that, and we do not want it to be a rewrite.

## Decision

**A `JobQueue` port with two adapters, selected by `QUEUE_DRIVER`.** (Settled stack
decision in SPEC.md.)

```ts
interface JobQueue {
  readonly driver: string;
  readonly concurrency: number;
  start(): Promise<void>;
  enqueue(id: string, payload: SlicePayload): Promise<void>;
  cancel(id: string): Promise<CancelOutcome>; // 'not-found' | 'dequeued' | 'signalled'
  stats(): Promise<QueueStats>;
  close(): Promise<void>;
}
```

The **handler is supplied at construction**, not per enqueue. A queue whose work
function can differ per item cannot be backed by a distributed broker without
serialising closures, so the port forbids it up front. The payload is required to be
JSON-serialisable for the same reason: an in-process adapter would happily carry a
`Buffer` or a callback, and that would be an interface the Redis adapter could never
satisfy.

`cancel()` returns an outcome rather than a boolean because "it was still queued, so it
will never run" and "it is running and has been signalled, so it will stop soon" are
different facts for the caller — `DELETE /jobs/:id` reports them differently.

### Default adapter: in-process

`InProcessJobQueue` — a FIFO of pending ids plus a running set, capped at
`concurrency`. Cancellation aborts an `AbortController` per running job, which the
job service forwards into `SlicerEngine.slice()`.

**The concurrency limit is documented and derived from CPU count.** Default:
`max(1, availableParallelism() - 1)`, overridable with `SLICE_CONCURRENCY`. The
reasoning: slicing saturates cores, so more concurrent slices than cores makes every
job slower without improving throughput, and leaving one core lets the API stay
responsive (SSE, uploads) while slices run. Memory is the other bound —
budget ~1 GB per concurrent slice for large models.

**Not durable.** A process restart loses queued jobs; the job store marks jobs left in
`queued`/`running` as `interrupted` at boot so no job is silently stuck forever. That
is the honest trade for zero operational dependencies, and it is written down here so
that it is a choice rather than a bug report.

### Stubbed adapter: BullMQ / Redis

`BullMqJobQueue` implements the same interface and **throws
`NotImplementedError` from every method**, with a message naming what is missing
(a Redis connection, a worker process, and job-payload durability). It is deliberately
not a silent no-op: a misconfigured `QUEUE_DRIVER=bullmq` must fail loudly at boot,
not accept jobs and drop them.

Selecting it is `QUEUE_DRIVER=bullmq` in the environment. Finishing it is a file, not a
refactor: nothing outside `queue/` knows which adapter is live, and the job service
holds only `JobQueue`.

## Consequences

- The sandbox lifecycle is **not** the queue's responsibility. The queue owns "when does
  this run and how many at once"; `jobs/job-service.ts` owns "create `/work/{id}`, slice,
  `rm -rf` in `finally`". Keeping those separate is what lets the timeout and
  cancellation paths share one cleanup path (hard constraint #4).
- Wall-clock timeout is enforced in the job service (via the same `AbortSignal` the
  queue uses for cancellation), with `--mstpp`/`--mtcpp` passed to the engine as a
  second line of defence. The queue does not know about time limits.
- Because the handler is fixed at construction and payloads are JSON, the acceptance
  test can run three real slices concurrently through the in-process adapter and the
  same test would be valid against the Redis adapter unchanged.
