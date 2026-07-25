/**
 * @orca-web/api — entry point.
 *
 * M1: POST /jobs, GET /jobs/:id/events (SSE), GET /jobs/:id/artifacts/:name,
 * DELETE /jobs/:id, a concurrency-limited JobQueue, guaranteed sandbox cleanup and
 * typed error mapping, with OrcaCliEngine behind the SlicerEngine port.
 */

import { ORCA_VERSION } from '@orca-web/shared';
import { createApp } from './app.js';

export { createApp } from './app.js';
export type { App, AppOverrides } from './app.js';
export { loadConfig } from './config.js';

export function describeBuild(): string {
  return `orcaslicer-web (OrcaSlicer ${ORCA_VERSION})`;
}

async function main(): Promise<void> {
  const app = await createApp();
  const shutdown = (signal: string): void => {
    app.server.log.info({ signal }, 'shutting down');
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.server.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.server.listen({ host: app.config.host, port: app.config.port });
  app.server.log.info(
    {
      queue: app.queue.driver,
      concurrency: app.queue.concurrency,
      workRoot: app.config.workRoot,
      dataDir: app.config.dataDir,
    },
    describeBuild(),
  );
}

// Only run the server when this module is the process entry point, so importing it from
// a test does not start listening.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
