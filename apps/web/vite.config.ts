/**
 * Vite config for the mobile client.
 *
 * In production there is no Vite and no second web server: `npm run build -w
 * @orca-web/web` emits `dist/`, the Dockerfile copies it into the image and the Fastify
 * API serves it (see `apps/api/src/http/static.ts`). This config's `server.proxy` exists
 * only so `npm run dev` behaves the same way — same origin, no CORS, SSE included.
 */

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** Every path the API owns. Anything else is the SPA. */
const API_PATHS = ['/catalog', '/jobs', '/models', '/plater', '/healthz'];

const target = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: Object.fromEntries(
      API_PATHS.map((path) => [
        path,
        {
          target,
          changeOrigin: false,
          // `GET /jobs/:id/events` is an SSE stream: it must not be buffered and it must
          // not time out. Both are the proxy's defaults for streams, but a 15-minute
          // slice outlives the default socket timeout, so it is raised explicitly.
          timeout: 0,
          proxyTimeout: 0,
        },
      ]),
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // The API sets `immutable` on /assets/*, which is only safe because Vite hashes
    // every emitted asset name.
    assetsDir: 'assets',
    target: 'es2022',
  },
});
