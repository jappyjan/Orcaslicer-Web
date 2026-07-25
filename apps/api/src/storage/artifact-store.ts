/**
 * Where artefacts live after the sandbox is gone.
 *
 * `/work/{jobId}` is deleted the moment a job ends (hard constraint #4), but
 * `GET /jobs/:id/artifacts/:name` has to keep working afterwards. So the two files a
 * user actually wants — the `.gcode.3mf` and the extracted `.gcode` — are copied out
 * into `<dataDir>/artifacts/{jobId}/` before cleanup runs. Everything else (profiles,
 * the assemble list, the slicer's own caches, the hundreds of megabytes of
 * intermediates) dies with the sandbox.
 */

import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ArtifactSummary } from '@orca-web/shared';
import type { EngineArtifact } from '../engine/port.js';

const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class ArtifactStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'artifacts');
  }

  dirFor(jobId: string): string {
    if (!SAFE_JOB_ID.test(jobId)) throw new Error(`unsafe job id: ${JSON.stringify(jobId)}`);
    return join(this.root, jobId);
  }

  /** Resolves and verifies containment; `name` comes straight off the URL. */
  pathFor(jobId: string, name: string): string | undefined {
    if (!SAFE_NAME.test(name)) return undefined;
    const dir = this.dirFor(jobId);
    const path = resolve(join(dir, name));
    return path.startsWith(`${resolve(dir)}/`) ? path : undefined;
  }

  async publish(jobId: string, files: readonly EngineArtifact[]): Promise<ArtifactSummary[]> {
    const dir = this.dirFor(jobId);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const published: ArtifactSummary[] = [];
    for (const file of files) {
      if (!SAFE_NAME.test(file.name)) throw new Error(`unsafe artefact name: ${file.name}`);
      const destination = join(dir, file.name);
      await copyFile(file.path, destination);
      const bytes = (await stat(destination)).size;
      published.push({
        name: file.name,
        bytes,
        contentType: file.contentType,
        role: file.role,
        ...(file.plate === undefined ? {} : { plate: file.plate }),
      });
    }
    return published;
  }

  async remove(jobId: string): Promise<void> {
    await rm(this.dirFor(jobId), { recursive: true, force: true });
  }
}
