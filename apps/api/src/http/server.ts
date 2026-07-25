/**
 * The HTTP surface.
 *
 *   POST   /models                    multipart upload → content ids (re-slice with no re-upload)
 *   POST   /jobs                      multipart: model files + `descriptor` JSON → 202 + job id
 *   GET    /jobs                      recent jobs
 *   GET    /jobs/:id                  one job
 *   GET    /jobs/:id/events           SSE progress
 *   GET    /jobs/:id/artifacts        artefact list
 *   GET    /jobs/:id/artifacts/:name  download (.gcode.3mf and the raw .gcode)
 *   GET    /jobs/:id/preview/*        G-code preview index + layer data (M5)
 *   DELETE /jobs/:id                  cancel and clean up
 *   GET    /catalog                   vendors → printer models → nozzle variants (?schema=1)
 *   GET    /catalog/presets           resolved process/filament presets for a printer
 *   GET    /healthz
 *   GET    /*                         the built web client (M3) — see http/static.ts
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  CreateJobResponse,
  HealthResponse,
  JobRequest,
  JobSummary,
  UploadModelsResponse,
} from '@orca-web/shared';
import type { CatalogService } from '../catalog/service.js';
import type { AppConfig } from '../config.js';
import type { SlicerEngine } from '../engine/port.js';
import { registerCatalogRoutes } from './catalog-routes.js';
import { registerPreviewRoutes } from './routes/preview.js';
import { PreviewStore } from '../preview/store.js';
import { isApiPath, registerStatic, wantsHtml } from './static.js';
import {
  BadRequestError,
  NotFoundError,
  assertModelFilename,
  type JobService,
  type UploadedModel,
} from '../jobs/job-service.js';
import type { JobEventBus } from '../jobs/event-bus.js';
import type { ProfileResolver } from '../profiles/port.js';
import type { JobQueue } from '../queue/port.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { JobStore } from '../storage/job-store.js';
import type { ModelStore } from '../storage/model-store.js';
import { toHttpFailure } from './errors.js';

export interface ServerDeps {
  config: AppConfig;
  engine: SlicerEngine;
  queue: JobQueue;
  jobs: JobStore;
  models: ModelStore;
  artifacts: ArtifactStore;
  events: JobEventBus;
  service: JobService;
  resolver: ProfileResolver;
  /** Absent only when the generated artefacts could not be loaded; `/catalog` then 503s. */
  catalog: CatalogService | undefined;
  /** M5's lazy G-code-preview cache. Defaulted from `artifacts`; injectable for tests. */
  preview?: PreviewStore;
}

const SSE_HEARTBEAT_MS = 15_000;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1024 * 1024,
    // Uploads from a phone on mobile data are slow; do not cut them off.
    requestTimeout: 0,
  });

  await app.register(multipart, {
    limits: {
      fileSize: deps.config.maxUploadBytes,
      files: 64,
      fields: 32,
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const failure = toHttpFailure(error);
    if (failure.status >= 500) {
      request.log.error({ err: error, detail: failure.detail }, 'request failed');
    } else {
      request.log.info(
        { code: failure.body.error.code, detail: failure.detail },
        'request rejected',
      );
    }
    void reply.status(failure.status).send(failure.body);
  });

  // The web client, when this build has one. Registered before the not-found handler so
  // the handler knows whether an `index.html` fallback is available.
  const site = await registerStatic(app, deps.config.webRoot);

  app.setNotFoundHandler((request, reply) => {
    // A single-page app owns its own routing: any GET that a browser navigates to and
    // that the API does not own gets index.html, so a reload or a shared link works.
    // Anything under an API prefix — and every fetch that did not ask for HTML — keeps
    // the JSON error envelope the rest of the API uses.
    if (site !== undefined && !isApiPath(request.url) && wantsHtml(request)) {
      void reply
        .status(200)
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(createReadStream(site.indexPath));
      return;
    }
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'No such endpoint.', retryable: false },
    });
  });

  // -------------------------------------------------------------------------

  registerCatalogRoutes(app, deps.catalog);
  registerPreviewRoutes(app, {
    jobs: deps.jobs,
    preview:
      deps.preview ??
      new PreviewStore(deps.artifacts, {
        log: (message, fields) => app.log.info(fields, message),
      }),
  });

  app.get('/healthz', async (): Promise<HealthResponse> => {
    const [info, stats] = await Promise.all([deps.engine.probe(), deps.queue.stats()]);
    const counts = deps.catalog?.query.catalog.report.counts;
    return {
      ok: true,
      engine: { id: info.id, version: info.version },
      queue: {
        driver: stats.driver,
        concurrency: stats.concurrency,
        queued: stats.queued,
        running: stats.running,
      },
      profiles: {
        resolver: deps.resolver.id,
        catalog:
          deps.catalog === undefined || counts === undefined
            ? null
            : {
                orcaVersion: deps.catalog.orcaVersion,
                vendors: counts.vendors,
                printerModels: counts.printerModels,
                presets: counts.presets,
              },
      },
    };
  });

  app.post('/models', async (request, reply) => {
    const { uploads, cleanup } = await consumeMultipart(request, deps);
    try {
      const body: UploadModelsResponse = { models: uploads.map((upload) => upload.model) };
      return await reply.status(201).send(body);
    } finally {
      await cleanup();
    }
  });

  app.post('/jobs', async (request, reply) => {
    const { uploads, fields, cleanup } = await consumeMultipart(request, deps);
    try {
      const raw = fields.descriptor ?? fields.job ?? fields.request;
      if (raw === undefined) {
        throw new BadRequestError(
          'the request needs a "descriptor" field holding the job JSON',
          'Send it as a multipart field alongside the model files.',
        );
      }
      let descriptor: JobRequest;
      try {
        descriptor = JSON.parse(raw) as JobRequest;
      } catch (error) {
        throw new BadRequestError(`the "descriptor" field is not valid JSON: ${String(error)}`);
      }

      const job = await deps.service.createJob(descriptor, uploads);
      const body: CreateJobResponse = {
        id: job.id,
        state: job.state,
        models: job.models,
        links: {
          self: `/jobs/${job.id}`,
          events: `/jobs/${job.id}/events`,
          artifacts: `/jobs/${job.id}/artifacts`,
        },
      };
      return await reply.status(202).send(body);
    } finally {
      await cleanup();
    }
  });

  app.get('/jobs', async () => ({ jobs: deps.jobs.list() }));

  app.get('/jobs/:id', async (request) => requireJob(deps, (request.params as { id: string }).id));

  app.get('/jobs/:id/artifacts', async (request) => {
    const job = requireJob(deps, (request.params as { id: string }).id);
    return { artifacts: job.artifacts };
  });

  app.get('/jobs/:id/artifacts/:name', async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    const job = requireJob(deps, id);
    const artifact = job.artifacts.find((candidate) => candidate.name === name);
    if (!artifact) throw new NotFoundError(`job ${id} has no artefact "${name}"`);

    const path = deps.artifacts.pathFor(id, name);
    if (path === undefined) throw new NotFoundError(`job ${id} has no artefact "${name}"`);
    try {
      await stat(path);
    } catch {
      throw new NotFoundError(`artefact "${name}" is no longer available`);
    }

    const label = (job.name ?? job.id).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
    return reply
      .header('Content-Type', artifact.contentType)
      .header('Content-Length', String(artifact.bytes))
      .header('Content-Disposition', `attachment; filename="${label}-${name}"`)
      .send(createReadStream(path));
  });

  app.delete('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    requireJob(deps, id);
    await deps.service.cancelAndDelete(id);
    return reply.status(204).send();
  });

  app.get('/jobs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    requireJob(deps, id);
    streamEvents(deps, id, request, reply);
    return reply;
  });

  return app;
}

function requireJob(deps: ServerDeps, id: string): JobSummary {
  const job = deps.jobs.get(id);
  if (!job) throw new NotFoundError(`no job ${id}`);
  return job;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function streamEvents(
  deps: ServerDeps,
  jobId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Take the socket off Fastify's hands: this response never ends on its own.
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer by default, which would defeat the whole feature.
    'X-Accel-Buffering': 'no',
  });

  const lastEventId = Number.parseInt(String(request.headers['last-event-id'] ?? '0'), 10);
  const after = Number.isFinite(lastEventId) ? lastEventId : 0;

  let closed = false;
  // Assigned below, but `end` can run during the replay inside subscribe() — which
  // happens before the assignment — so it must be checked, not captured.
  let unsubscribe: (() => void) | undefined = undefined;
  const end = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    raw.end();
  };

  const heartbeat = setInterval(() => {
    if (!closed) raw.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  unsubscribe = deps.events.subscribe(jobId, after, ({ seq, event }) => {
    if (closed) return;
    raw.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done' || event.type === 'failed') end();
  });

  // If the replay already delivered the terminal event, `end()` ran during subscribe()
  // and the unsubscribe above landed after it; drop the listener now.
  if (closed) unsubscribe();

  // A job that finished before this request arrived still has to terminate the stream.
  const terminal = deps.events.terminal(jobId);
  if (terminal !== undefined && terminal.seq > after) end();

  request.raw.on('close', end);
  request.raw.on('error', end);
}

// ---------------------------------------------------------------------------
// Multipart
// ---------------------------------------------------------------------------

interface ConsumedMultipart {
  uploads: UploadedModel[];
  fields: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * Files are streamed to a scratch directory and then handed to the content-addressed
 * store, so a 400 MB upload never sits in the heap. The scratch directory is removed
 * whatever happens — it lives under `<dataDir>/tmp`, not under `/work`, because `/work`
 * belongs exclusively to job sandboxes.
 */
async function consumeMultipart(
  request: FastifyRequest,
  deps: ServerDeps,
): Promise<ConsumedMultipart> {
  if (!request.isMultipart()) {
    throw new BadRequestError('this endpoint expects a multipart/form-data request');
  }

  const scratch = join(deps.config.dataDir, 'tmp', randomUUID());
  await mkdir(scratch, { recursive: true });
  const cleanup = async (): Promise<void> => {
    await rm(scratch, { recursive: true, force: true });
  };

  const uploads: UploadedModel[] = [];
  const fields: Record<string, string> = {};

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      const filename = assertModelFilename(part.filename);
      const temp = join(scratch, `${uploads.length}-${filename}`);
      await pipeline(part.file, createWriteStream(temp));
      if (part.file.truncated) {
        throw new BadRequestError(
          `"${filename}" is larger than this server accepts`,
          `The limit is ${deps.config.maxUploadBytes} bytes.`,
        );
      }
      const model = await deps.models.putFile(temp, filename);
      uploads.push({ filename, model });
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { uploads, fields, cleanup };
}
