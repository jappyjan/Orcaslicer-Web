/**
 * Job orchestration: validation, model staging, sandbox lifecycle, engine invocation,
 * artefact publication, event fan-out.
 *
 * This file sits ABOVE the engine boundary and must stay free of OrcaSlicer specifics
 * (docs/adr/0001-slicer-engine-boundary.md). It knows about `SlicerEngine`,
 * `JobQueue` and `ProfileResolver`, never about CLI flags or `.gcode.3mf`.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type {
  ApiError,
  JobRequest,
  JobSummary,
  ModelRef,
  ModelSummary,
  PresetRef,
  ResolvedProfile,
} from '@orca-web/shared';
import type { AppConfig } from '../config.js';
import { SliceError, toSliceError } from '../engine/errors.js';
import type {
  EngineInput,
  EngineObject,
  EnginePlate,
  SliceJob,
  SlicerEngine,
} from '../engine/port.js';
import { runSlice } from '../engine/run.js';
import { ProfileNotFoundError, type ProfileResolver } from '../profiles/port.js';
import type { CancelOutcome, JobQueue } from '../queue/port.js';
import { withSandbox } from '../sandbox.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { JobStore } from '../storage/job-store.js';
import type { ModelStore } from '../storage/model-store.js';
import type { JobEventBus } from './event-bus.js';

export class BadRequestError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'BadRequestError';
    this.hint = hint;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** A file that arrived with the request, already stored in the model library. */
export interface UploadedModel {
  filename: string;
  model: ModelSummary;
}

export interface JobServiceDeps {
  config: AppConfig;
  engine: SlicerEngine;
  resolver: ProfileResolver;
  jobs: JobStore;
  models: ModelStore;
  artifacts: ArtifactStore;
  events: JobEventBus;
  log: (
    level: 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

const MODEL_EXTENSIONS = new Set(['.stl', '.3mf', '.obj', '.step', '.stp', '.amf']);

export function assertModelFilename(filename: string): string {
  const base = basename(filename)
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .trim();
  if (base === '' || base.startsWith('.'))
    throw new BadRequestError(`invalid file name "${filename}"`);
  const ext = extname(base).toLowerCase();
  if (!MODEL_EXTENSIONS.has(ext)) {
    throw new BadRequestError(
      `"${base}" is not a supported model file`,
      `Supported formats: ${[...MODEL_EXTENSIONS].join(', ')}.`,
    );
  }
  return base;
}

export class JobService {
  private readonly deps: JobServiceDeps;
  private queue: JobQueue | undefined;

  constructor(deps: JobServiceDeps) {
    this.deps = deps;
  }

  /** The queue is injected after construction because its handler is this service. */
  attachQueue(queue: JobQueue): void {
    this.queue = queue;
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  async createJob(request: JobRequest, uploads: readonly UploadedModel[]): Promise<JobSummary> {
    validateRequest(request);
    // Fail fast: a bad preset name is a 4xx on submit, not a job that fails a minute
    // later. Resolution is cached, so the worker's own resolve() is free.
    await this.resolveProfiles(request);

    const byFilename = new Map(uploads.map((upload) => [upload.filename, upload.model]));
    const used = new Map<string, ModelSummary>();

    // Rewrite every `upload:` reference into a `library:` one before the request is
    // persisted. After this point a job is expressed purely in content ids, which is
    // what makes "re-slice at different settings without re-uploading" a client-side
    // no-op: the same descriptor works next week.
    const resolveRef = (ref: ModelRef): ModelRef => {
      const model =
        ref.source === 'upload'
          ? byFilename.get(basename(ref.filename))
          : this.deps.models.get(ref.id);
      if (!model) {
        throw ref.source === 'upload'
          ? new BadRequestError(
              `the job refers to an uploaded file "${ref.filename}" that was not part of the request`,
            )
          : new NotFoundError(`model ${ref.id} is not in the library`);
      }
      this.deps.models.touch(model.id);
      used.set(model.id, model);
      return { source: 'library', id: model.id };
    };

    const normalised: JobRequest =
      request.input.kind === 'models'
        ? {
            ...request,
            input: { kind: 'models', models: request.input.models.map(resolveRef) },
          }
        : {
            ...request,
            input: {
              kind: 'plates',
              plates: request.input.plates.map((plate) => ({
                ...plate,
                objects: plate.objects.map((object) => ({
                  ...object,
                  model: resolveRef(object.model),
                })),
              })),
            },
          };

    if (used.size === 0) throw new BadRequestError('a job needs at least one model');

    const id = randomUUID();
    const summary = this.deps.jobs.create({
      id,
      name: request.name ?? null,
      request: normalised,
      models: [...used.values()],
    });
    this.publishState(id, 'queued');

    if (!this.queue) throw new Error('job service has no queue attached');
    await this.queue.enqueue({ jobId: id });
    return summary;
  }

  // -------------------------------------------------------------------------
  // Execution — the queue handler
  // -------------------------------------------------------------------------

  handler = async (payload: { jobId: string }, signal: AbortSignal): Promise<void> => {
    const { jobId } = payload;
    const request = this.deps.jobs.getRequest(jobId);
    if (!request) return;

    this.deps.jobs.markRunning(jobId);
    this.publishState(jobId, 'running');

    try {
      const summary = await this.runSliceJob(jobId, request, signal);
      this.deps.events.publish(jobId, {
        type: 'done',
        jobId,
        job: summary,
        at: new Date().toISOString(),
      });
    } catch (error) {
      const sliceError = toSliceError(error);
      const apiError: ApiError = sliceError.toApiError();
      const state = sliceError.code === 'CANCELLED' ? 'cancelled' : 'failed';
      this.deps.jobs.markFinished(jobId, state, apiError);
      this.deps.log(state === 'cancelled' ? 'info' : 'error', `job ${state}`, {
        jobId,
        code: sliceError.code,
        detail: sliceError.detail,
      });
      this.publishState(jobId, state);
      this.deps.events.publish(jobId, {
        type: 'failed',
        jobId,
        error: apiError,
        at: new Date().toISOString(),
      });
    }
  };

  private async runSliceJob(
    jobId: string,
    request: JobRequest,
    signal: AbortSignal,
  ): Promise<JobSummary> {
    const { config, engine, jobs, artifacts, events, log } = this.deps;
    const profiles = await this.resolveProfiles(request);

    const outcome = await withSandbox(
      config.workRoot,
      jobId,
      {
        onCleanupError: (error) =>
          // Hard constraint #4: an unswept sandbox is 200–500 MB that never comes back.
          log('error', 'sandbox cleanup failed — disk will leak', { jobId, error: String(error) }),
      },
      async (sandbox) => {
        const staged = await this.stageModels(request, sandbox.path);
        const input = buildEngineInput(request, staged);

        const sliceJob: SliceJob = {
          id: jobId,
          workDir: sandbox.path,
          input,
          machine: profiles.machine,
          process: profiles.process,
          filaments: profiles.filaments,
          ...(request.filamentColours === undefined
            ? {}
            : { filamentColours: request.filamentColours }),
          plate: request.plate ?? 0,
          overrides: request.overrides ?? {},
          limits: {
            wallClockMs: config.sliceTimeoutMs,
            maxSecondsPerPlate: config.maxSecondsPerPlate,
            maxTrianglesPerPlate: config.maxTrianglesPerPlate,
          },
        };

        const warnings: string[] = [];
        const result = await runSlice(
          engine,
          sliceJob,
          {
            signal,
            progressIntervalMs: config.progressIntervalMs,
            onLog: (line) => log('info', line, { jobId }),
          },
          (progress) => {
            if (progress.warning !== null && !warnings.includes(progress.warning)) {
              warnings.push(progress.warning);
            }
            jobs.setProgress(jobId, progress.totalPercent, progress.message, warnings);
            events.publish(jobId, {
              type: 'progress',
              jobId,
              percent: progress.totalPercent,
              plateIndex: progress.plateIndex,
              plateCount: progress.plateCount,
              platePercent: progress.platePercent,
              message: progress.message,
              warning: progress.warning,
              at: new Date().toISOString(),
            });
          },
        );

        // Copy the two files a user wants out of the sandbox BEFORE it is destroyed.
        return {
          stats: result.stats,
          warnings: result.warnings,
          artifacts: await artifacts.publish(jobId, result.files),
        };
      },
    );

    // Deliberately after `withSandbox` has returned, i.e. after the sandbox has been
    // removed: a client that sees `succeeded` can rely on the job holding no disk.
    jobs.markSucceeded(jobId, outcome.stats, outcome.artifacts, outcome.warnings);
    this.publishState(jobId, 'succeeded');
    return jobs.get(jobId) as JobSummary;
  }

  // -------------------------------------------------------------------------
  // Cancellation and deletion
  // -------------------------------------------------------------------------

  async cancel(jobId: string): Promise<CancelOutcome> {
    const state = this.deps.jobs.state(jobId);
    if (state === undefined) throw new NotFoundError(`no job ${jobId}`);
    if (!this.queue) throw new Error('job service has no queue attached');

    const outcome = await this.queue.cancel(jobId);
    if (outcome === 'dequeued') {
      const error: ApiError = {
        code: 'CANCELLED',
        message: 'The job was cancelled before it started.',
        retryable: true,
      };
      this.deps.jobs.markFinished(jobId, 'cancelled', error);
      this.publishState(jobId, 'cancelled');
      this.deps.events.publish(jobId, {
        type: 'failed',
        jobId,
        error,
        at: new Date().toISOString(),
      });
    }
    return outcome;
  }

  /**
   * `DELETE /jobs/:id`: cancel, wait for the worker to unwind (which is what runs the
   * sandbox `finally`), then drop artefacts and metadata.
   */
  async cancelAndDelete(jobId: string, waitMs = 15_000): Promise<void> {
    const outcome = await this.cancel(jobId);
    if (outcome === 'signalled') await this.waitForTerminal(jobId, waitMs);
    await this.deps.artifacts.remove(jobId);
    this.deps.jobs.delete(jobId);
    this.deps.events.forget(jobId);
  }

  private async waitForTerminal(jobId: string, waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = this.deps.jobs.state(jobId);
      if (state === undefined || (state !== 'queued' && state !== 'running')) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private publishState(jobId: string, state: JobSummary['state']): void {
    this.deps.events.publish(jobId, { type: 'state', jobId, state, at: new Date().toISOString() });
  }

  private async resolveProfiles(request: JobRequest): Promise<{
    machine: ResolvedProfile;
    process: ResolvedProfile;
    filaments: ResolvedProfile[];
  }> {
    const resolve = async (ref: PresetRef, kind: PresetRef['kind']): Promise<ResolvedProfile> => {
      try {
        return await this.deps.resolver.resolve({ ...ref, kind });
      } catch (error) {
        if (error instanceof ProfileNotFoundError) {
          throw new NotFoundError(`no ${kind} preset "${ref.name}" for vendor "${ref.vendor}"`);
        }
        throw new SliceError('PROFILE_INVALID', `The ${kind} preset could not be loaded.`, {
          hint: 'Choose a different preset.',
          detail: String(error),
          cause: error,
        });
      }
    };

    const [machine, process] = await Promise.all([
      resolve(request.printer, 'machine'),
      resolve(request.process, 'process'),
    ]);
    const filaments = await Promise.all(request.filaments.map((ref) => resolve(ref, 'filament')));
    return { machine, process, filaments };
  }

  /**
   * Copy the library blobs the job needs into its sandbox.
   *
   * A hard link is tried first (free, and the blob is immutable so sharing an inode is
   * safe); `/work` is usually a tmpfs on a different filesystem, in which case it falls
   * back to a copy. Either way the library blob itself is never handed to the engine.
   */
  private async stageModels(
    request: JobRequest,
    sandboxPath: string,
  ): Promise<Map<string, string>> {
    const dir = join(sandboxPath, 'models');
    await mkdir(dir, { recursive: true });

    const refs: ModelRef[] =
      request.input.kind === 'models'
        ? [...request.input.models]
        : request.input.plates.flatMap((plate) => plate.objects.map((object) => object.model));

    const staged = new Map<string, string>();
    let index = 0;
    for (const ref of refs) {
      const key = refKey(ref);
      if (staged.has(key)) continue;
      const model = this.lookupModel(ref);
      index += 1;
      const target = join(dir, `${index}-${model.filename}`);
      const source = this.deps.models.pathFor(model.id);
      try {
        await link(source, target);
      } catch {
        await copyFile(source, target);
      }
      staged.set(key, target);
    }
    return staged;
  }

  private lookupModel(ref: ModelRef): ModelSummary {
    // `createJob` rewrote every reference into a library id before persisting the
    // request, so an upload reference reaching the worker is a bug, not user input.
    if (ref.source !== 'library') throw new Error(`unresolved upload reference "${ref.filename}"`);
    const model = this.deps.models.get(ref.id);
    if (!model) throw new NotFoundError(`model ${ref.id} is not in the library`);
    return model;
  }
}

function refKey(ref: ModelRef): string {
  return ref.source === 'library' ? `library:${ref.id}` : `upload:${basename(ref.filename)}`;
}

function validateRequest(request: JobRequest): void {
  if (!request || typeof request !== 'object') throw new BadRequestError('missing job descriptor');
  for (const [field, ref] of [
    ['printer', request.printer],
    ['process', request.process],
  ] as const) {
    if (!ref || typeof ref.name !== 'string' || typeof ref.vendor !== 'string') {
      throw new BadRequestError(`"${field}" must name a preset (vendor + name)`);
    }
  }
  if (!Array.isArray(request.filaments) || request.filaments.length === 0) {
    throw new BadRequestError('"filaments" must list at least one filament preset');
  }
  if (!request.input || typeof request.input !== 'object') {
    throw new BadRequestError('"input" is required');
  }
  if (request.input.kind === 'plates') {
    if (!Array.isArray(request.input.plates) || request.input.plates.length === 0) {
      throw new BadRequestError('"input.plates" must contain at least one plate');
    }
  } else if (request.input.kind === 'models') {
    if (!Array.isArray(request.input.models) || request.input.models.length === 0) {
      throw new BadRequestError('"input.models" must contain at least one model');
    }
  } else {
    throw new BadRequestError('"input.kind" must be "plates" or "models"');
  }
  if (request.plate !== undefined && (!Number.isInteger(request.plate) || request.plate < 0)) {
    throw new BadRequestError('"plate" must be 0 (all plates) or a positive plate number');
  }
}

function buildEngineInput(request: JobRequest, staged: ReadonlyMap<string, string>): EngineInput {
  const pathFor = (ref: ModelRef): string => {
    const path = staged.get(refKey(ref));
    if (path === undefined) throw new Error('model was not staged into the sandbox');
    return path;
  };

  if (request.input.kind === 'models') {
    return { kind: 'files', paths: request.input.models.map(pathFor) };
  }

  const plates: EnginePlate[] = request.input.plates.map((plate, plateIndex) => ({
    index: plate.index ?? plateIndex + 1,
    name: plate.name ?? `plate_${plate.index ?? plateIndex + 1}`,
    arrange: plate.arrange ?? false,
    objects: plate.objects.map((object): EngineObject => {
      const count = object.count ?? 1;
      const engineObject: EngineObject = {
        path: pathFor(object.model),
        count,
        filaments: object.filaments ?? [1],
        assembleIndex: object.assembleIndex ?? [1],
        subtype: object.subtype ?? 'ModelPart',
        printParams: object.printParams ?? {},
        heightRanges: (object.heightRanges ?? []).map((range) => ({
          minZ: range.minZ,
          maxZ: range.maxZ,
          rangeParams: range.rangeParams ?? {},
        })),
      };
      // pos_x/pos_y are only honoured when the plate is not auto-arranged, so they are
      // only ever sent in that case (see engine/orca/assemble-list.ts).
      if (object.posX !== undefined) engineObject.posX = object.posX;
      if (object.posY !== undefined) engineObject.posY = object.posY;
      if (object.posZ !== undefined) engineObject.posZ = object.posZ;
      return engineObject;
    }),
  }));

  return { kind: 'plates', plates };
}
