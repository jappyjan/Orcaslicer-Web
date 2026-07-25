/**
 * Composition root: the one place adapters are chosen and wired together.
 *
 * Everything below is constructed against a port — swapping the queue driver, the
 * profile resolver or the slicer engine is an edit here (or an env var), never a change
 * to a call site.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type AppConfig, loadConfig } from './config.js';
import { OrcaCliEngine } from './engine/orca/orca-cli-engine.js';
import type { SlicerEngine } from './engine/port.js';
import { JobEventBus } from './jobs/event-bus.js';
import { JobService } from './jobs/job-service.js';
import type { ProfileResolver } from './profiles/port.js';
import { StopgapProfileResolver } from './profiles/stopgap-resolver.js';
import { createQueue } from './queue/create.js';
import type { JobQueue } from './queue/port.js';
import { purgeWorkRoot } from './sandbox.js';
import { ArtifactStore } from './storage/artifact-store.js';
import { type Db, openDatabase } from './storage/db.js';
import { JobStore } from './storage/job-store.js';
import { ModelStore } from './storage/model-store.js';
import { buildServer } from './http/server.js';

export interface AppOverrides {
  config?: Partial<AppConfig>;
  /** Unit tests substitute a mock engine here; the acceptance test must not. */
  engine?: SlicerEngine;
  resolver?: ProfileResolver;
}

export interface App {
  config: AppConfig;
  server: FastifyInstance;
  queue: JobQueue;
  jobs: JobStore;
  models: ModelStore;
  artifacts: ArtifactStore;
  events: JobEventBus;
  service: JobService;
  engine: SlicerEngine;
  db: Db;
  close(): Promise<void>;
}

export async function createApp(overrides: AppOverrides = {}): Promise<App> {
  const config: AppConfig = { ...loadConfig(), ...overrides.config };

  await mkdir(config.dataDir, { recursive: true });
  // A crash or `docker kill` skips the sandbox `finally`, so boot is the only chance to
  // notice what was left behind (hard constraint #4).
  await purgeWorkRoot(config.workRoot);

  const db = openDatabase(join(config.dataDir, 'orcaslicer-web.db'));
  const jobs = new JobStore(db);
  const models = new ModelStore(db, {
    dataDir: config.dataDir,
    maxBytes: config.modelLibraryMaxBytes,
    ttlMs: config.modelTtlMs,
  });
  const artifacts = new ArtifactStore(config.dataDir);
  const events = new JobEventBus();

  const engine =
    overrides.engine ??
    new OrcaCliEngine({
      binary: config.orcaBinary,
      ...(process.env.XDG_RUNTIME_DIR === undefined
        ? {}
        : { xdgRuntimeDir: process.env.XDG_RUNTIME_DIR }),
    });

  const resolver =
    overrides.resolver ??
    new StopgapProfileResolver({
      resourcesDir: config.orcaResources,
      resolverScript: config.resolverScript,
    });

  const interrupted = jobs.interruptStale();

  const service = new JobService({
    config,
    engine,
    resolver,
    jobs,
    models,
    artifacts,
    events,
    log: (level, message, fields) => {
      const payload = { message, ...fields };
      if (level === 'error') console.error(payload);
      else if (level === 'warn') console.warn(payload);
    },
  });

  const queue = createQueue(config, {
    handler: service.handler,
    onError: (error, payload) => console.error({ message: 'queue handler threw', payload, error }),
  });
  service.attachQueue(queue);
  await queue.start();

  const server = await buildServer({
    config,
    engine,
    queue,
    jobs,
    models,
    artifacts,
    events,
    service,
  });

  if (interrupted.length > 0) {
    server.log.warn({ jobs: interrupted }, 'marked jobs interrupted after restart');
  }

  // LRU/TTL sweeper for the model library plus artefact retention. Jobs that are still
  // queued or running protect their models from eviction.
  const sweeper = setInterval(() => {
    void (async () => {
      try {
        const result = await models.sweep(jobs.activeModelIds());
        if (result.evicted > 0) {
          server.log.info({ ...result }, 'swept model library');
        }
        for (const jobId of jobs.expiredJobIds(config.jobRetentionMs)) {
          await artifacts.remove(jobId);
          jobs.delete(jobId);
          events.forget(jobId);
        }
      } catch (error) {
        server.log.error({ err: error }, 'sweep failed');
      }
    })();
  }, config.sweepIntervalMs);
  sweeper.unref();

  return {
    config,
    server,
    queue,
    jobs,
    models,
    artifacts,
    events,
    service,
    engine,
    db,
    async close() {
      clearInterval(sweeper);
      await queue.close();
      await server.close();
      db.close();
    },
  };
}
