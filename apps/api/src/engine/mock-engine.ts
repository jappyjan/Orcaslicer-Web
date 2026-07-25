/**
 * A real implementation of `SlicerEngine` that does not slice.
 *
 * Used by the unit tests for the happy path, cancellation and timeout semantics, which
 * the working agreement allows. It is NOT allowed anywhere near the acceptance test:
 * that one runs the real binary in the container.
 *
 * It lives in `src/` rather than in a test file because several test files share it and
 * because it doubles as the proof that the port is implementable without any
 * Orca-shaped assumptions leaking into it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SliceStats } from '@orca-web/shared';
import { SliceError } from './errors.js';
import type {
  ArrangeJob,
  ArrangeResult,
  EngineInfo,
  SliceArtifacts,
  SliceJob,
  SliceOptions,
  SliceProgress,
  SlicerEngine,
} from './port.js';

export interface MockEngineConfig {
  /** Progress steps to emit, in order. */
  steps?: number;
  /** Delay between steps. */
  stepMs?: number;
  /** Throw this instead of finishing. */
  failWith?: SliceError;
  /** Bytes written to the fake artefact, so "non-empty" assertions mean something. */
  artifactBytes?: number;
  onSpawn?: (job: SliceJob) => void;
}

const STATS: SliceStats = {
  predictionSeconds: 1221,
  weightGrams: 7.54,
  totalMetres: 2.49,
  layerCount: 100,
  plates: [
    {
      index: 1,
      predictionSeconds: 1221,
      weightGrams: 7.54,
      layerCount: 100,
      filaments: [{ id: 1, type: 'PLA', colour: '#F2754E', usedMetres: 2.49, usedGrams: 7.54 }],
      outside: false,
      supportUsed: false,
    },
  ],
};

export class MockSlicerEngine implements SlicerEngine {
  readonly id = 'mock';
  private readonly config: MockEngineConfig;
  /** Sandbox paths seen, so tests can assert they were removed afterwards. */
  readonly seenWorkDirs: string[] = [];
  /** One entry per arrange() call: the staged paths it was asked to lay out. */
  readonly arranged: string[][] = [];
  readonly thumbnails: Array<{ artifactPath: string; plate: number; bytes: number }> = [];

  constructor(config: MockEngineConfig = {}) {
    this.config = config;
  }

  async probe(): Promise<EngineInfo> {
    return { id: this.id, version: '0.0.0-mock' };
  }

  /**
   * A grid, 60 mm apart, centred on nothing in particular. It exists so the arrange route
   * can be tested without the binary; the real packing is the engine's (SPEC: delegate to
   * `--arrange 1`), and a caller that depends on the exact layout is depending on the
   * wrong thing.
   */
  async arrange(job: ArrangeJob): Promise<ArrangeResult> {
    this.arranged.push(job.objects.map((object) => object.path));
    const columns = Math.max(1, Math.ceil(Math.sqrt(job.objects.length)));
    return {
      placements: job.objects.map((_, index) => ({
        position: [50 + (index % columns) * 60, 50 + Math.floor(index / columns) * 60, 0],
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      })),
    };
  }

  async embedPlateThumbnail(artifactPath: string, plate: number, png: Uint8Array): Promise<number> {
    this.thumbnails.push({ artifactPath, plate, bytes: png.byteLength });
    await writeFile(`${artifactPath}.thumb-${plate}.png`, png);
    return png.byteLength;
  }

  async *slice(
    job: SliceJob,
    options: SliceOptions = {},
  ): AsyncGenerator<SliceProgress, SliceArtifacts> {
    this.seenWorkDirs.push(job.workDir);
    this.config.onSpawn?.(job);

    const steps = this.config.steps ?? 4;
    const stepMs = this.config.stepMs ?? 5;
    const outDir = join(job.workDir, 'out');
    await mkdir(outDir, { recursive: true });
    // Something bulky enough that a leaked sandbox would be visible on disk.
    await writeFile(join(job.workDir, 'intermediate.bin'), Buffer.alloc(64 * 1024, 7));

    try {
      for (let step = 1; step <= steps; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        if (options.signal?.aborted === true) {
          throw new SliceError('CANCELLED', 'The job was cancelled.', { retryable: true });
        }
        yield {
          plateIndex: 1,
          plateCount: 1,
          platePercent: (step / steps) * 100,
          totalPercent: (step / steps) * 100,
          message: `step ${step}`,
          warning: step === 2 ? 'Unsupported overhangs detected' : null,
        };
      }

      if (this.config.failWith) throw this.config.failWith;

      const projectPath = join(outDir, 'result.gcode.3mf');
      const gcodePath = join(outDir, 'plate_1.gcode');
      const bytes = this.config.artifactBytes ?? 4096;
      await writeFile(projectPath, Buffer.alloc(bytes, 3));
      await writeFile(gcodePath, '; total layer number: 100\nG1 X1 Y1 E.02345\n');

      return {
        files: [
          {
            name: 'result.gcode.3mf',
            path: projectPath,
            bytes,
            contentType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
            role: 'project',
          },
          {
            name: 'plate_1.gcode',
            path: gcodePath,
            bytes: 42,
            contentType: 'text/x.gcode',
            role: 'gcode',
            plate: 1,
          },
        ],
        stats: STATS,
        warnings: ['Unsupported overhangs detected'],
      };
    } finally {
      // The real adapter kills its process group here; the mock only has to prove the
      // hook runs on cancellation as well as on success.
      this.config.onSpawn?.(job);
    }
  }
}
