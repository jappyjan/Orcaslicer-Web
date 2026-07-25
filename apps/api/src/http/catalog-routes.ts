/**
 * The catalog surface (M2's "serve both via `GET /catalog`").
 *
 *   GET /catalog[?schema=1]                                     the browsable index
 *   GET /catalog/presets?type=…&model=…&nozzle=…[&vendor=…]     fully resolved presets
 *
 * Both are static for a pinned OrcaSlicer version, so both are served from a
 * pre-serialised string with a strong ETag and honour `If-None-Match` with a 304. See
 * `catalog/service.ts` for the caching itself.
 *
 * Error bodies follow the same shape as every other route — `{ error: { code, message,
 * hint?, retryable } }` with a user-safe `message` — via the shared error handler in
 * `http/errors.ts`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CatalogService } from '../catalog/service.js';
import { CatalogUnavailableError } from '../catalog/service.js';
import { BadRequestError } from '../jobs/job-service.js';
import type { CachedBody } from '../catalog/service.js';

/**
 * An hour of freshness, then revalidate — cheap, because revalidation is a 304 against
 * a version-keyed ETag. `immutable` is deliberately not used: the URL carries no
 * version, so an image rebuilt on a newer OrcaSlicer must be able to win.
 */
const CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=604800';

function truthy(value: unknown): boolean {
  return value === '1' || value === 'true' || value === '';
}

function sendCached(request: FastifyRequest, reply: FastifyReply, body: CachedBody): FastifyReply {
  reply.header('Cache-Control', CACHE_CONTROL).header('ETag', body.etag);
  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && matches(ifNoneMatch, body.etag)) {
    return reply.status(304).send();
  }
  return reply.type('application/json; charset=utf-8').send(body.json);
}

/** `If-None-Match` is a comma-separated list, and a proxy may have weakened the tag. */
function matches(header: string, etag: string): boolean {
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag || candidate === '*');
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  catalog: CatalogService | undefined,
): void {
  const require = (): CatalogService => {
    if (!catalog) {
      throw new CatalogUnavailableError('the generated profile catalog was not loaded at start-up');
    }
    return catalog;
  };

  app.get('/catalog', async (request, reply) => {
    const query = request.query as { schema?: string };
    return sendCached(request, reply, require().catalogResponse(truthy(query.schema)));
  });

  app.get('/catalog/presets', async (request, reply) => {
    const query = request.query as {
      type?: string;
      model?: string;
      vendor?: string;
      nozzle?: string;
    };

    if (query.type !== 'process' && query.type !== 'filament') {
      throw new BadRequestError(
        '"type" must be "process" or "filament"',
        'e.g. /catalog/presets?type=process&model=Bambu%20Lab%20H2S&nozzle=0.4',
      );
    }
    if (query.model === undefined || query.model.trim() === '') {
      throw new BadRequestError(
        '"model" is required and names a printer model from GET /catalog',
        'e.g. /catalog/presets?type=process&model=Bambu%20Lab%20H2S&nozzle=0.4',
      );
    }

    return sendCached(
      request,
      reply,
      require().presetsResponse({
        type: query.type,
        model: query.model,
        vendor: query.vendor,
        nozzle: query.nozzle,
      }),
    );
  });
}
