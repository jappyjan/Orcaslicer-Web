/**
 * Configuration. Every knob is an environment variable with a defensible default, so
 * the stack runs with an empty `.env` on a small VPS.
 */

import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

export type QueueDriver = 'memory' | 'bullmq';

export interface AppConfig {
  host: string;
  port: number;
  /** Root of the disposable per-job sandboxes (hard constraint #4). */
  workRoot: string;
  /** Persistent state: SQLite database, model library, job artefacts. */
  dataDir: string;
  orcaBinary: string;
  orcaResources: string;
  /** M1 stopgap flattener; see profiles/port.ts for the seam M2 replaces. */
  resolverScript: string;
  queueDriver: QueueDriver;
  redisUrl: string | undefined;
  /** Documented in ADR 0002. Slicing is CPU-bound, so this defaults from CPU count. */
  concurrency: number;
  sliceTimeoutMs: number;
  maxSecondsPerPlate: number;
  maxTrianglesPerPlate: number;
  progressIntervalMs: number;
  /** Per-file upload cap. */
  maxUploadBytes: number;
  /** Total bytes the content-addressed model library may hold before LRU eviction. */
  modelLibraryMaxBytes: number;
  /** Models untouched for longer than this are swept even when under quota. */
  modelTtlMs: number;
  sweepIntervalMs: number;
  /** Job rows (and their artefacts) older than this are swept. */
  jobRetentionMs: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`expected a positive number, got "${value}"`);
  }
  return parsed;
}

/**
 * Default parallelism: slicing saturates cores, so running more slices than cores makes
 * every job slower without improving throughput. Leaving one core free keeps uploads and
 * SSE responsive while slices run. Budget roughly 1 GB of RAM per concurrent slice.
 */
export function defaultConcurrency(): number {
  return Math.max(1, availableParallelism() - 1);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driver = (env.QUEUE_DRIVER ?? 'memory') as QueueDriver;
  if (driver !== 'memory' && driver !== 'bullmq') {
    throw new Error(`QUEUE_DRIVER must be "memory" or "bullmq", got "${env.QUEUE_DRIVER ?? ''}"`);
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port: num(env.PORT, 8080),
    workRoot: env.WORK_DIR ?? '/work',
    dataDir: env.DATA_DIR ?? '/data',
    orcaBinary: env.ORCA_BIN ?? 'orca-slicer',
    orcaResources: env.ORCA_RESOURCES ?? '/opt/orcaslicer/resources',
    resolverScript:
      env.RESOLVE_PROFILE_SCRIPT ??
      fileURLToPath(new URL('../../../scripts/resolve-profile.mjs', import.meta.url)),
    queueDriver: driver,
    redisUrl: env.REDIS_URL,
    concurrency: num(env.SLICE_CONCURRENCY, defaultConcurrency()),
    sliceTimeoutMs: num(env.SLICE_TIMEOUT_MS, 15 * 60 * 1000),
    maxSecondsPerPlate: num(env.MAX_SECONDS_PER_PLATE, 10 * 60),
    maxTrianglesPerPlate: num(env.MAX_TRIANGLES_PER_PLATE, 20_000_000),
    progressIntervalMs: num(env.PROGRESS_INTERVAL_MS, 1_000),
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    modelLibraryMaxBytes: num(env.MODEL_LIBRARY_MAX_BYTES, 4 * 1024 * 1024 * 1024),
    modelTtlMs: num(env.MODEL_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    sweepIntervalMs: num(env.SWEEP_INTERVAL_MS, 15 * 60 * 1000),
    jobRetentionMs: num(env.JOB_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
  };
}
