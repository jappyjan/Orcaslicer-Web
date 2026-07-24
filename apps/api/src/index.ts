/**
 * @orca-web/api — Fastify server.
 *
 * M0 placeholder: the container is proven, the HTTP surface is not built yet.
 * M1 adds POST /jobs, GET /jobs/:id/events (SSE), GET /jobs/:id/artifacts/:name,
 * DELETE /jobs/:id, the concurrency-limited JobQueue port and the SlicerEngine
 * port with OrcaCliEngine as its first adapter (hard constraint #3).
 */

import { ORCA_VERSION } from '@orca-web/shared';

export function describeBuild(): string {
  return `orcaslicer-web (OrcaSlicer ${ORCA_VERSION})`;
}
