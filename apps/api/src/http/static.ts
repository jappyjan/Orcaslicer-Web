/**
 * Serving the web client.
 *
 * The spec's container decision is one image with "frontend built as static assets served
 * by the API" — so there is no nginx, no second container and no CORS anywhere in this
 * project. `apps/web` builds to `apps/web/dist`, the Dockerfile copies it next to the
 * compiled API, and this module hands it out.
 *
 * Two behaviours matter and are easy to get wrong:
 *
 *  - **Cache headers.** `index.html` must never be cached (it names the hashed bundles),
 *    while everything under `/assets/` may be cached for ever, because Vite puts a
 *    content hash in each file name. Getting this backwards ships a stale app that only
 *    a hard reload fixes — on a phone, effectively for ever.
 *  - **SPA fallback.** A deep link or a reload must return `index.html`, but a typo'd
 *    API path must still return the JSON error envelope every other route returns.
 *    {@link isApiPath} is the line between the two.
 *
 * When `dist/` is absent — a source checkout that has not run `npm run build -w
 * @orca-web/web`, or a unit test — registration is skipped and the API serves its JSON
 * routes alone. That is a warning, not a boot failure: the API is useful without the UI.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Path prefixes the API owns. Everything else belongs to the single-page app. */
const API_PREFIXES = ['/jobs', '/models', '/catalog', '/plater', '/healthz'];

/**
 * `<api>/dist/http/static.js` → `apps/web/dist`.
 *
 * The same relative shape holds in a source checkout (`apps/api/src/http`) and in the
 * image (`/app/apps/api/dist/http`), which is why the Dockerfile copies the web bundle
 * to `/app/apps/web/dist` rather than somewhere more obvious.
 */
export function defaultWebRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
}

export function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** A browser navigation, as opposed to a fetch that wants JSON. */
export function wantsHtml(request: Pick<FastifyRequest, 'method' | 'headers'>): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

export interface StaticSite {
  root: string;
  indexPath: string;
}

/**
 * Register the static site if it was built. Returns the site, or `undefined` when there
 * is nothing to serve.
 */
export async function registerStatic(
  app: FastifyInstance,
  root: string,
): Promise<StaticSite | undefined> {
  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath)) {
    app.log.warn(
      { root },
      'no built web client found; serving the API only (run `npm run build -w @orca-web/web`)',
    );
    return undefined;
  }

  await app.register(fastifyStatic, {
    root,
    index: ['index.html'],
    // Explicit routes per file rather than a `/*` catch-all, so an unknown path reaches
    // the not-found handler — which is where the SPA fallback and the JSON error
    // envelope decide between themselves.
    wildcard: false,
    setHeaders(response, path) {
      // The callback gets a FastifyReply, not the raw ServerResponse, so this is
      // `header()`. Calling `setHeader()` here throws and every asset 500s.
      if (path.endsWith('.html')) {
        response.header('cache-control', 'no-cache');
      } else {
        // Safe only because Vite content-hashes every emitted asset name.
        response.header('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.log.info({ root }, 'serving the web client');
  return { root, indexPath };
}
