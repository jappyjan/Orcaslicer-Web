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
  ModelTransform,
  PresetRef,
  ResolvedProfile,
  SettingOverrides,
} from '@orca-web/shared';
import type { ConfigSchemaDocument } from '@orca-web/catalog';
import type { AppConfig } from '../config.js';
import { SliceError, toSliceError } from '../engine/errors.js';
import { UnknownSettingError, coerceOverrides } from '../settings/schema.js';
import { MeshError, bakeTransform, isIdentityTransform } from '../geometry/mesh.js';
import type {
  ArrangePlacement,
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
  /**
   * M2's generated config schema, used to validate M6's overrides before they become
   * engine arguments. Absent when the server booted without the generated artefacts, in
   * which case overrides are passed through unvalidated — the engine still refuses a key
   * that is not a config identifier.
   */
  settingsSchema?: ConfigSchemaDocument | undefined;
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

/**
 * A ceiling on what one arrange call may lay out. Not a product limit — a plate with
 * hundreds of instances is a phone problem long before it is a server problem — but the
 * request stages a file per instance, so it needs a bound.
 */
const MAX_ARRANGE_OBJECTS = 64;

/** `POST /plater/arrange`, once the route has validated it. */
export interface ArrangeRequest {
  printer: PresetRef;
  process: PresetRef;
  /** One entry per instance; `count` has no meaning here. */
  objects: Array<{ model: ModelRef; transform?: ModelTransform }>;
}

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
    const overrides = this.validateOverrides(request.overrides);

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

    // `overrides` is stored in its coerced form, so a re-slice of a persisted request
    // reproduces the same command line rather than re-guessing the value shapes.
    const normalised: JobRequest =
      request.input.kind === 'models'
        ? {
            ...request,
            overrides,
            input: { kind: 'models', models: request.input.models.map(resolveRef) },
          }
        : {
            ...request,
            overrides,
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
        const staged = await this.stageModels(modelsOf(request), sandbox.path);
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
  // The plater's two side doors (M4)
  // -------------------------------------------------------------------------

  /**
   * Lay a plate out with the engine's own packer.
   *
   * SPEC: auto-arrange "delegates to `--arrange 1`" — we do not write a bin packer. The
   * engine is the only thing that knows the bed's exclusion zones and clearances, and a
   * second implementation would disagree with it exactly where it matters.
   *
   * Runs in a disposable sandbox like any other engine invocation (hard constraint #4);
   * it is short, but a rotated model still has to be baked to disk before the packer can
   * measure it.
   */
  async arrangePlate(request: ArrangeRequest): Promise<ArrangePlacement[]> {
    if (request.objects.length === 0) return [];
    if (request.objects.length > MAX_ARRANGE_OBJECTS) {
      throw new BadRequestError(
        `a plate cannot hold more than ${MAX_ARRANGE_OBJECTS} objects`,
        'Delete a few and try again.',
      );
    }
    const [machine, process] = await Promise.all([
      this.resolveOne(request.printer, 'machine'),
      this.resolveOne(request.process, 'process'),
    ]);

    const id = `arrange-${randomUUID()}`;
    return withSandbox(
      this.deps.config.workRoot,
      id,
      {
        onCleanupError: (error) =>
          this.deps.log('error', 'sandbox cleanup failed — disk will leak', {
            jobId: id,
            error: String(error),
          }),
      },
      async (sandbox) => {
        // Reuses the job path's staging, so an arranged plate measures exactly the
        // geometry a slice would: same baking, same file, same bounding box.
        const staged = await this.stageModels(
          request.objects.map((object) =>
            object.transform === undefined
              ? { ref: object.model }
              : { ref: object.model, transform: object.transform },
          ),
          sandbox.path,
        );
        const objects = request.objects.map((object) => ({
          path: staged.get(stagedKey(object.model, object.transform)) as string,
        }));
        const result = await this.deps.engine.arrange({
          id,
          workDir: sandbox.path,
          objects,
          machine,
          process,
          wallClockMs: this.deps.config.arrangeTimeoutMs,
        });
        return result.placements;
      },
    );
  }

  /**
   * Write a client-rendered plate preview into a finished job's project archive.
   *
   * SPEC: the slicer needs OpenGL for this and there is no display server, so the
   * `.gcode.3mf` we serve would otherwise show an empty preview on the printer's screen.
   * VERIFIED DEVIATION #5: with `--min-save` the member is absent rather than blank.
   */
  async attachPlateThumbnail(jobId: string, plate: number, png: Uint8Array): Promise<number> {
    const job = this.deps.jobs.get(jobId);
    if (!job) throw new NotFoundError(`no job ${jobId}`);
    const artifact = job.artifacts.find((candidate) => candidate.role === 'project');
    if (!artifact) {
      throw new BadRequestError(
        `job ${jobId} has no project archive to put a preview into`,
        job.state === 'succeeded' ? undefined : 'Wait for the slice to finish.',
      );
    }
    const path = this.deps.artifacts.pathFor(jobId, artifact.name);
    if (path === undefined) throw new NotFoundError(`job ${jobId} has no artefact to update`);

    const bytes = await this.deps.engine.embedPlateThumbnail(path, plate, png);
    this.deps.jobs.setArtifacts(
      jobId,
      job.artifacts.map((candidate) =>
        candidate.name === artifact.name ? { ...candidate, bytes } : candidate,
      ),
    );
    return bytes;
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

  /**
   * M6's overrides, checked against the generated config schema before they can become
   * engine arguments.
   *
   * Rejecting rather than dropping is the point: an override the server silently ignored
   * would slice with the preset's value while the UI went on showing the user's, which is
   * the same class of quiet-wrong-output failure as SPEC deviation #1.
   */
  private validateOverrides(raw: JobRequest['overrides']): SettingOverrides {
    if (raw === undefined) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestError('"overrides" must be an object of setting keys');
    }
    const schema = this.deps.settingsSchema;
    if (schema === undefined) return raw;
    try {
      return coerceOverrides(schema, raw as Record<string, unknown>);
    } catch (error) {
      if (error instanceof UnknownSettingError)
        throw new BadRequestError(error.message, error.hint);
      throw error;
    }
  }

  private publishState(jobId: string, state: JobSummary['state']): void {
    this.deps.events.publish(jobId, { type: 'state', jobId, state, at: new Date().toISOString() });
  }

  private async resolveOne(ref: PresetRef, kind: PresetRef['kind']): Promise<ResolvedProfile> {
    if (!ref || typeof ref.name !== 'string' || typeof ref.vendor !== 'string') {
      throw new BadRequestError(`"${kind}" must name a preset (vendor + name)`);
    }
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
  }

  private async resolveProfiles(request: JobRequest): Promise<{
    machine: ResolvedProfile;
    process: ResolvedProfile;
    filaments: ResolvedProfile[];
  }> {
    const [machine, process] = await Promise.all([
      this.resolveOne(request.printer, 'machine'),
      this.resolveOne(request.process, 'process'),
    ]);
    const filaments = await Promise.all(
      request.filaments.map((ref) => this.resolveOne(ref, 'filament')),
    );
    return { machine, process, filaments };
  }

  /**
   * Copy the library blobs the job needs into its sandbox.
   *
   * A hard link is tried first (free, and the blob is immutable so sharing an inode is
   * safe); `/work` is usually a tmpfs on a different filesystem, in which case it falls
   * back to a copy. Either way the library blob itself is never handed to the engine.
   *
   * An object carrying a non-identity {@link PlateObject.transform} is the exception: the
   * plate description has positions and no rotation or scale, so the transform is baked
   * into a fresh binary STL here (`geometry/mesh.ts`). The library blob is still never
   * mutated — the baked copy lives and dies with the sandbox — and two objects that share
   * a model *and* a transform still stage once.
   */
  private async stageModels(
    wanted: ReadonlyArray<{ ref: ModelRef; transform?: ModelTransform }>,
    sandboxPath: string,
  ): Promise<Map<string, string>> {
    const dir = join(sandboxPath, 'models');
    await mkdir(dir, { recursive: true });

    const staged = new Map<string, string>();
    let index = 0;
    for (const { ref, transform } of wanted) {
      const key = stagedKey(ref, transform);
      if (staged.has(key)) continue;
      const model = this.lookupModel(ref);
      index += 1;
      const source = this.deps.models.pathFor(model.id);

      if (transform !== undefined && !isIdentityTransform(transform)) {
        const target = join(
          dir,
          `${index}-${basename(model.filename, extname(model.filename))}.stl`,
        );
        try {
          await bakeTransform(source, target, transform, model.filename);
        } catch (error) {
          if (error instanceof MeshError) {
            throw new SliceError(
              'INPUT_UNREADABLE',
              'A rotated or resized model could not be read.',
              {
                hint: 'Reset the model to its original orientation, or re-export it as an STL.',
                detail: `${model.filename}: ${error.message}`,
                cause: error,
              },
            );
          }
          throw error;
        }
        staged.set(key, target);
        continue;
      }

      const target = join(dir, `${index}-${model.filename}`);
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

/** Every model a job refers to, with the transform it will be baked with. */
function modelsOf(request: JobRequest): Array<{ ref: ModelRef; transform?: ModelTransform }> {
  if (request.input.kind === 'models') return request.input.models.map((ref) => ({ ref }));
  return request.input.plates.flatMap((plate) =>
    plate.objects.map((object) =>
      object.transform === undefined
        ? { ref: object.model }
        : { ref: object.model, transform: object.transform },
    ),
  );
}

/**
 * What "the same staged file" means: the same model *and* the same baked transform. Two
 * copies of one model at different rotations are two files in the sandbox; two copies at
 * the same rotation are one.
 */
function stagedKey(ref: ModelRef, transform?: readonly number[]): string {
  const model = ref.source === 'library' ? `library:${ref.id}` : `upload:${basename(ref.filename)}`;
  return isIdentityTransform(transform) ? model : `${model}|${transform?.join(',') ?? ''}`;
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
    for (const plate of request.input.plates) {
      for (const object of plate.objects ?? []) {
        if (object.transform === undefined) continue;
        if (
          !Array.isArray(object.transform) ||
          object.transform.length !== 9 ||
          object.transform.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
          throw new BadRequestError(
            '"transform" must be nine finite numbers (a row-major 3x3 matrix)',
            'It carries rotation and scale; the translation is posX/posY/posZ.',
          );
        }
      }
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
  const pathFor = (ref: ModelRef, transform?: readonly number[]): string => {
    const path = staged.get(stagedKey(ref, transform));
    if (path === undefined) throw new Error('model was not staged into the sandbox');
    return path;
  };

  if (request.input.kind === 'models') {
    return { kind: 'files', paths: request.input.models.map((ref) => pathFor(ref)) };
  }

  const plates: EnginePlate[] = request.input.plates.map((plate, plateIndex) => ({
    index: plate.index ?? plateIndex + 1,
    name: plate.name ?? `plate_${plate.index ?? plateIndex + 1}`,
    arrange: plate.arrange ?? false,
    objects: plate.objects.map((object): EngineObject => {
      const count = object.count ?? 1;
      const engineObject: EngineObject = {
        path: pathFor(object.model, object.transform),
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
