/**
 * The G-code preview cache (M5, server side).
 *
 * A job's G-code never changes, so its preview is compiled at most once and then lives
 * beside the job's other artefacts in `<dataDir>/artifacts/{jobId}/`:
 *
 *   plate_1.gcode           published by the engine adapter
 *   plate_1.preview.json    the layer index
 *   plate_1.preview.bin     the layer chunks
 *
 * Putting it there rather than in a separate cache directory means `DELETE /jobs/:id`
 * and the retention sweeper already clean it up — `ArtifactStore.remove` takes the whole
 * directory — and a preview survives a restart exactly as long as the download does.
 *
 * Compilation is lazy: parsing every slice eagerly would spend CPU on jobs nobody
 * previews, and the parse is 2.7 s for a 42 MiB plate on the four-core box this was
 * measured on. It is also single-flighted, because a client that opens the preview
 * screen fetches the index and a layer window within a few milliseconds of each other
 * and must not start two parses.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PREVIEW_VERSION, type PreviewIndex, compilePreview } from '@orca-web/gcode';
import type { ArtifactSummary, JobSummary } from '@orca-web/shared';
import type { ArtifactStore } from '../storage/artifact-store.js';

/** The job exists but has nothing to preview (still running, failed, or no G-code). */
export class NoPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoPreviewError';
  }
}

export interface PreviewEntry {
  index: PreviewIndex;
  /** Absolute path to the `.bin`. */
  dataPath: string;
  /** Strong validator over the index; the `.bin` derives its own from it. */
  etag: string;
}

export interface PreviewStoreOptions {
  /**
   * Parses allowed to run at once.
   *
   * The parse is CPU-bound and shares a box with the slicer, whose concurrency is
   * already capped (ADR 0002). Two is enough to keep a second visitor from waiting
   * behind a long parse without turning the preview endpoint into a way to starve
   * slicing.
   */
  maxConcurrent?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export function previewIndexName(plate: number): string {
  return `plate_${plate}.preview.json`;
}

export function previewDataName(plate: number): string {
  return `plate_${plate}.preview.bin`;
}

/** Plates this job has G-code for, ascending. */
export function previewablePlates(job: JobSummary): number[] {
  return job.artifacts
    .filter(
      (artifact): artifact is ArtifactSummary & { plate: number } =>
        artifact.role === 'gcode' && typeof artifact.plate === 'number',
    )
    .map((artifact) => artifact.plate)
    .sort((a, b) => a - b);
}

export class PreviewStore {
  private readonly artifacts: ArtifactStore;
  private readonly inFlight = new Map<string, Promise<PreviewEntry>>();
  private readonly maxConcurrent: number;
  private readonly log: (message: string, fields: Record<string, unknown>) => void;
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(artifacts: ArtifactStore, options: PreviewStoreOptions = {}) {
    this.artifacts = artifacts;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.log = options.log ?? ((): void => undefined);
  }

  /**
   * The preview for one plate, compiling it if this is the first request.
   *
   * Throws `NoPreviewError` when the job has no G-code for that plate.
   */
  async get(job: JobSummary, plate: number): Promise<PreviewEntry> {
    const key = `${job.id}/${plate}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const work = this.load(job, plate).finally(() => {
      this.inFlight.delete(key);
    });
    // Held only for the duration of the compile: the result is a pair of files on disk,
    // and keeping a parsed 22 KB index per job in a process-lifetime map is exactly the
    // kind of unbounded growth this service should not have.
    this.inFlight.set(key, work);
    return work;
  }

  private async load(job: JobSummary, plate: number): Promise<PreviewEntry> {
    const indexPath = this.pathFor(job.id, previewIndexName(plate));
    const dataPath = this.pathFor(job.id, previewDataName(plate));

    const cached = await this.readCached(indexPath, dataPath);
    if (cached) return { index: cached, dataPath, etag: etagFor(job.id, plate, cached) };

    const gcode = job.artifacts.find(
      (artifact) => artifact.role === 'gcode' && artifact.plate === plate,
    );
    if (!gcode) {
      throw new NoPreviewError(
        job.state === 'succeeded'
          ? `This job has no plate ${plate}.`
          : 'This job has not produced any G-code yet.',
      );
    }
    const gcodePath = this.artifacts.pathFor(job.id, gcode.name);
    if (gcodePath === undefined) throw new NoPreviewError('The G-code for this job is gone.');
    if (!(await exists(gcodePath))) {
      throw new NoPreviewError('The G-code for this job is no longer available.');
    }

    await this.acquire();
    try {
      // Re-check under the gate: a request that queued behind another one for the same
      // plate would otherwise recompile it. The single-flight map covers the common
      // case; this covers a second request arriving after the first resolved but before
      // its files were observed.
      const raced = await this.readCached(indexPath, dataPath);
      if (raced) return { index: raced, dataPath, etag: etagFor(job.id, plate, raced) };

      await mkdir(this.artifacts.dirFor(job.id), { recursive: true, mode: 0o700 });
      const started = Date.now();
      const index = await compilePreview({
        gcodePath,
        binPath: dataPath,
        indexPath,
        plate,
        gcodeName: gcode.name,
      });
      this.log('compiled gcode preview', {
        jobId: job.id,
        plate,
        sourceBytes: gcode.bytes,
        previewBytes: index.stats.bytes,
        layers: index.stats.layers,
        segments: index.stats.segments,
        ms: Date.now() - started,
      });
      return { index, dataPath, etag: etagFor(job.id, plate, index) };
    } finally {
      this.release();
    }
  }

  private pathFor(jobId: string, name: string): string {
    const path = this.artifacts.pathFor(jobId, name);
    // Both names are built from a validated integer plate, so this is a programming
    // error rather than a request the caller can fix.
    if (path === undefined) throw new Error(`unsafe preview artefact name: ${name}`);
    return path;
  }

  /**
   * Reuse an earlier parse when it is complete and current.
   *
   * The index is written last and the `.bin` is renamed into place before it, so an
   * index whose recorded byte count matches the `.bin` on disk can only have come from a
   * compile that finished. A `version` bump invalidates every cached parse without a
   * migration or a manual sweep.
   */
  private async readCached(indexPath: string, dataPath: string): Promise<PreviewIndex | undefined> {
    try {
      const raw = await readFile(indexPath, 'utf8');
      const index = JSON.parse(raw) as PreviewIndex;
      if (index.version !== PREVIEW_VERSION) return undefined;
      const data = await stat(dataPath);
      if (data.size !== index.stats.bytes) return undefined;
      return index;
    } catch {
      return undefined;
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

/**
 * A strong validator.
 *
 * The compiler is deterministic and the source G-code is immutable for the life of the
 * job, so hashing the index — which records the byte count, the per-layer counts and the
 * quantisation of the `.bin` it describes — identifies the `.bin` as precisely as
 * hashing 26 MB of it would, at a thousandth of the cost.
 */
function etagFor(jobId: string, plate: number, index: PreviewIndex): string {
  const digest = createHash('sha256')
    .update(`${PREVIEW_VERSION} ${jobId} ${plate} `)
    .update(JSON.stringify(index))
    .digest('base64url')
    .slice(0, 27);
  return `"${digest}"`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
