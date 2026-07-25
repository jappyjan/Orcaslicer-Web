/**
 * Serving the built web client (M3): the API is the only web server in the stack, so the
 * SPA fallback and the cache headers are its problem.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorResponse, PresetRef, ResolvedProfile } from '@orca-web/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../app.js';
import { MockSlicerEngine } from '../engine/mock-engine.js';
import type { ProfileResolver } from '../profiles/port.js';
import { isApiPath, wantsHtml } from './static.js';

class FakeResolver implements ProfileResolver {
  readonly id = 'fake';
  async resolve(ref: PresetRef): Promise<ResolvedProfile> {
    return { ...ref, values: {}, chain: [ref.name] };
  }
}

const INDEX_HTML = '<!doctype html><title>OrcaSlicer Web</title><div id="root"></div>';

let app: App | undefined;
let root = '';
let baseUrl = '';

async function boot(withSite: boolean): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'static-test-'));
  const webRoot = join(root, 'web');
  if (withSite) {
    await mkdir(join(webRoot, 'assets'), { recursive: true });
    await writeFile(join(webRoot, 'index.html'), INDEX_HTML);
    await writeFile(join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1)\n');
  }
  app = await createApp({
    config: {
      workRoot: join(root, 'work'),
      dataDir: join(root, 'data'),
      webRoot,
      concurrency: 1,
    },
    engine: new MockSlicerEngine({ steps: 1, stepMs: 1 }),
    resolver: new FakeResolver(),
  });
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  // The pure-function suite below boots nothing.
  if (app === undefined) return;
  await app.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('with a built client', () => {
  beforeEach(async () => {
    await boot(true);
  });

  it('serves index.html at the root', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('OrcaSlicer Web');
  });

  it('never caches index.html but caches hashed assets for ever', async () => {
    // Backwards, this ships an app that only a hard reload fixes — on a phone, for ever.
    const index = await fetch(baseUrl);
    expect(index.headers.get('cache-control')).toBe('no-cache');

    const asset = await fetch(`${baseUrl}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for a client-side route', async () => {
    const response = await fetch(`${baseUrl}/anything/deep`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('OrcaSlicer Web');
  });

  it('still returns the JSON error envelope for an unknown API path', async () => {
    // A typo'd API call must not receive an HTML page, whatever it says it accepts.
    const response = await fetch(`${baseUrl}/jobs/nope/nope`, {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('does not hand HTML to a fetch that wanted JSON', async () => {
    const response = await fetch(`${baseUrl}/somewhere`, {
      headers: { accept: 'application/json' },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('leaves the API routes alone', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });
});

describe('without a built client', () => {
  beforeEach(async () => {
    await boot(false);
  });

  it('boots anyway and serves the API', async () => {
    // A source checkout that has not run `npm run build -w @orca-web/web` is a warning,
    // not a boot failure: the API is useful on its own.
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    const response = await fetch(baseUrl, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiErrorResponse).error.code).toBe('NOT_FOUND');
  });
});

describe('path classification', () => {
  it('knows which prefixes the API owns', () => {
    expect(isApiPath('/jobs')).toBe(true);
    expect(isApiPath('/jobs/abc/events')).toBe(true);
    expect(isApiPath('/catalog/presets?type=process')).toBe(true);
    expect(isApiPath('/healthz')).toBe(true);
    expect(isApiPath('/jobsomething')).toBe(false);
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/settings/deep/link')).toBe(false);
  });

  it('only offers HTML to a navigation', () => {
    expect(wantsHtml({ method: 'GET', headers: { accept: 'text/html' } })).toBe(true);
    expect(wantsHtml({ method: 'POST', headers: { accept: 'text/html' } })).toBe(false);
    expect(wantsHtml({ method: 'GET', headers: { accept: 'application/json' } })).toBe(false);
    expect(wantsHtml({ method: 'GET', headers: {} })).toBe(false);
  });
});
