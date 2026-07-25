/**
 * Configuration. Every knob is an environment variable with a defensible default, so
 * the stack runs with an empty `.env` on a small VPS.
 */

import { availableParallelism } from 'node:os';
import { configSchemaPath, ORCA_VERSION, profileCatalogPath } from '@orca-web/catalog';
import { defaultWebRoot } from './http/static.js';

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
  /** Pinned OrcaSlicer release. Keys the generated artefacts and the catalog ETags. */
  orcaVersion: string;
  /**
   * The generated profile catalog (M2). Produced at image-build time into
   * `/generated/<version>/` and read once at start-up — see docs/PROFILE-PIPELINE.md.
   */
  profileCatalogPath: string;
  /** The generated config schema, served with `GET /catalog?schema=1` and used by M6. */
  configSchemaPath: string;
  /**
   * The built web client (M3). One image, one process: the API serves `apps/web/dist` as
   * static assets — there is no second web server. Absent in a checkout that has not run
   * `npm run build -w @orca-web/web`, in which case the API serves its JSON routes alone.
   */
  webRoot: string;
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
  // `ORCA_VERSION` is set by the runtime image from the Dockerfile's `ARG ORCA_VERSION`,
  // so the artefacts the API reads can never belong to a different release than the
  // binary it shells out to (hard constraint #2).
  const version = env.ORCA_VERSION?.trim() || ORCA_VERSION;

  return {
    host: env.HOST ?? '0.0.0.0',
    port: num(env.PORT, 8080),
    workRoot: env.WORK_DIR ?? '/work',
    dataDir: env.DATA_DIR ?? '/data',
    orcaBinary: env.ORCA_BIN ?? 'orca-slicer',
    orcaResources: env.ORCA_RESOURCES ?? '/opt/orcaslicer/resources',
    orcaVersion: version,
    profileCatalogPath: env.PROFILE_CATALOG_PATH ?? profileCatalogPath(version),
    configSchemaPath: env.CONFIG_SCHEMA_PATH ?? configSchemaPath(version),
    webRoot: env.WEB_ROOT ?? defaultWebRoot(),
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
