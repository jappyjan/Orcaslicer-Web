/**
 * The G-code preview surface (M5, server side).
 *
 *   GET /jobs/:id/preview               which plates can be previewed
 *   GET /jobs/:id/preview/:plate        the layer index (compiles on first request)
 *   GET /jobs/:id/preview/:plate/data   the layer chunks, byte-range addressable
 *
 * The client fetches the index once, then range-requests only the layers it is showing.
 * `docs/GCODE-PREVIEW-FORMAT.md` is the contract; the short version is:
 *
 *   offset = index.layers.offset[first]
 *   end    = index.layers.offset[last] + index.layers.count[last] * index.segmentBytes - 1
 *   fetch(dataUrl, { headers: { Range: `bytes=${offset}-${end}` } })
 *
 * Both bodies are immutable for the life of the job — the G-code they describe cannot
 * change — so they carry a strong `ETag` and a year of `max-age`, with `immutable`. That
 * is the one thing standing between a layer slider and a request per frame.
 *
 * Error bodies are the same `{ error: { code, message, hint?, retryable } }` envelope as
 * every other route, produced by the shared handler in `http/errors.ts`; nothing here
 * formats its own.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JobSummary } from '@orca-web/shared';
import { BadRequestError, NotFoundError } from '../../jobs/job-service.js';
import { NoPreviewError, type PreviewStore, previewablePlates } from '../../preview/store.js';
import type { JobStore } from '../../storage/job-store.js';

/**
 * A year, immutable. Unlike `/catalog` — whose URL carries no version and must be able
 * to lose to a rebuilt image — a job id names one immutable slice, so a cached response
 * can never become wrong. `immutable` also stops Safari revalidating on every reload,
 * which on a phone is the difference between a slider that scrubs and one that stutters.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export interface PreviewRouteDeps {
  jobs: JobStore;
  preview: PreviewStore;
}

export function registerPreviewRoutes(app: FastifyInstance, deps: PreviewRouteDeps): void {
  const requireJob = (id: string): JobSummary => {
    const job = deps.jobs.get(id);
    if (!job) throw new NotFoundError(`There is no job ${id}.`);
    return job;
  };

  app.get('/jobs/:id/preview', async (request) => {
    const { id } = request.params as { id: string };
    const job = requireJob(id);
    return {
      jobId: job.id,
      state: job.state,
      plates: previewablePlates(job).map((plate) => ({
        plate,
        links: {
          index: `/jobs/${job.id}/preview/${plate}`,
          data: `/jobs/${job.id}/preview/${plate}/data`,
        },
      })),
    };
  });

  app.get('/jobs/:id/preview/:plate', async (request, reply) => {
    const { id, plate } = request.params as { id: string; plate: string };
    const job = requireJob(id);
    const entry = await load(deps, job, parsePlate(plate));

    reply.header('Cache-Control', CACHE_CONTROL).header('ETag', entry.etag);
    if (matchesEtag(request.headers['if-none-match'], entry.etag)) {
      return reply.status(304).send();
    }
    return reply.type('application/json; charset=utf-8').send(entry.index);
  });

  app.get('/jobs/:id/preview/:plate/data', async (request, reply) => {
    const { id, plate } = request.params as { id: string; plate: string };
    const job = requireJob(id);
    const entry = await load(deps, job, parsePlate(plate));

    // The `.bin` is a different representation of the same resource, so it needs its own
    // validator; deriving it from the index's keeps them invalidated together.
    const etag = `${entry.etag.slice(0, -1)}-d"`;
    const size = (await stat(entry.dataPath)).size;

    reply
      .header('Cache-Control', CACHE_CONTROL)
      .header('ETag', etag)
      // Without this a browser will not issue a Range request at all, and the client
      // would be forced to download every layer to show one.
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', 'application/octet-stream');

    if (matchesEtag(request.headers['if-none-match'], etag)) {
      return reply.status(304).send();
    }

    const range = parseRange(request, etag, size);
    if (range === 'unsatisfiable') {
      return (
        reply
          .status(416)
          .header('Content-Range', `bytes */${size}`)
          // The success path already set `application/octet-stream`; the error envelope is
          // JSON like every other error in this API.
          .type('application/json; charset=utf-8')
          .send({
            error: {
              code: 'BAD_REQUEST',
              message: 'That layer range is outside the preview data.',
              hint: 'Re-read the index; the layer offsets it lists are the only valid ones.',
              retryable: false,
            },
          })
      );
    }

    if (range === undefined) {
      return reply.header('Content-Length', String(size)).send(createReadStream(entry.dataPath));
    }

    return reply
      .status(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', String(range.end - range.start + 1))
      .send(createReadStream(entry.dataPath, { start: range.start, end: range.end }));
  });
}

async function load(
  deps: PreviewRouteDeps,
  job: JobSummary,
  plate: number,
): ReturnType<PreviewStore['get']> {
  try {
    return await deps.preview.get(job, plate);
  } catch (error) {
    // "Nothing to preview" is a 404 about this job, not a server fault. Anything else —
    // a parse that threw, a disk that filled — falls through to the shared handler,
    // which logs it and answers with the generic 500 envelope.
    if (error instanceof NoPreviewError) throw new NotFoundError(error.message);
    throw error;
  }
}

function parsePlate(raw: string): number {
  const plate = Number(raw);
  if (!Number.isInteger(plate) || plate < 1 || plate > 64) {
    throw new BadRequestError(
      'The plate number must be a positive whole number.',
      'GET /jobs/:id/preview lists the plates this job has.',
    );
  }
  return plate;
}

/** `If-None-Match` is a comma-separated list, and a proxy may have weakened the tag. */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag || candidate === '*');
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * One `bytes=` range, or nothing.
 *
 * Multi-range requests are answered in full rather than as `multipart/byteranges`: a
 * layer window is contiguous by construction, so the client never needs more than one
 * range, and RFC 9110 lets a server ignore the header entirely.
 */
function parseRange(
  request: FastifyRequest,
  etag: string,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  const header = request.headers.range;
  if (typeof header !== 'string') return undefined;

  // `If-Range` guards against a client stitching bytes from two different parses
  // together after a version bump invalidated its cache.
  const ifRange = request.headers['if-range'];
  if (typeof ifRange === 'string' && ifRange.trim().replace(/^W\//, '') !== etag) {
    return undefined;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  if (size === 0) return 'unsatisfiable';

  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-N`: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    if (start >= size) return 'unsatisfiable';
    if (end < start) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
