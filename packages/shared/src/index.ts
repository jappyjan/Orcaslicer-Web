/**
 * Types shared between the API (`@orca-web/api`) and the web client (`@orca-web/web`).
 *
 * Everything that crosses the HTTP boundary belongs here and nowhere else. Nothing in
 * this file may mention OrcaSlicer, its CLI flags or its archive layout — the engine is
 * an implementation detail behind the `SlicerEngine` port (see
 * docs/adr/0001-slicer-engine-boundary.md).
 */

/** The OrcaSlicer release this build is pinned to. Mirrors `ARG ORCA_VERSION` in the Dockerfile. */
export const ORCA_VERSION = '2.4.2' as const;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** Which of the three preset families a profile belongs to. */
export type PresetKind = 'machine' | 'process' | 'filament';

/**
 * A reference to a preset the server can resolve.
 *
 * M1 resolves these straight out of the container's bundled `resources/profiles`
 * tree. M2's catalog replaces the resolver behind the same reference shape, so the
 * client-visible contract does not change.
 */
export interface PresetRef {
  kind: PresetKind;
  /** Vendor directory, e.g. `BBL`. */
  vendor: string;
  /** Preset name without the `.json` suffix, e.g. `0.20mm Standard @BBL X1C`. */
  name: string;
}

/**
 * A preset with its inheritance chain fully flattened.
 *
 * VERIFIED DEVIATION #1 (docs/SPEC.md): the CLI does not resolve `inherits` and fails
 * *silently* when handed a raw preset — wrong bed size, zero filament density, exit 0.
 * Nothing may reach an engine adapter except in this shape.
 */
export interface ResolvedProfile extends PresetRef {
  /** Flattened key/value pairs. Never contains `inherits`. */
  values: Record<string, unknown>;
  /** Presets walked while flattening, leaf first. Diagnostic only. */
  chain: string[];
}

// ---------------------------------------------------------------------------
// Job submission
// ---------------------------------------------------------------------------

/**
 * How a job refers to a model file.
 *
 * `upload` names a file part in the same multipart request; `library` names a
 * previously stored, content-addressed model so a re-slice costs no upload — which
 * matters enormously on a phone.
 */
export type ModelRef = { source: 'upload'; filename: string } | { source: 'library'; id: string };

/** Volume roles the engine understands. `NegativeVolume`/`ParameterModifier` are the M4+ hook. */
export type ObjectSubtype = 'ModelPart' | 'NegativeVolume' | 'ParameterModifier';

/** One object (possibly several copies of it) on a plate. */
export interface PlateObject {
  model: ModelRef;
  /** Number of copies. Default 1. */
  count?: number;
  /** 1-based filament slot indices. Length must be 1 or `count`. */
  filaments?: number[];
  /** Objects sharing a value are merged into one composed model. */
  assembleIndex?: number[];
  /** Only honoured when the plate's `arrange` is false. Length must be 1 or `count`. */
  posX?: number[];
  posY?: number[];
  posZ?: number[];
  subtype?: ObjectSubtype;
  /** Per-object process overrides, e.g. `{ support_type: 'normal(auto)' }`. */
  printParams?: Record<string, string | number | boolean>;
  heightRanges?: HeightRange[];
}

export interface HeightRange {
  minZ: number;
  maxZ: number;
  rangeParams?: Record<string, string | number | boolean>;
}

export interface PlateSpec {
  /** 1-based plate index. */
  index?: number;
  name?: string;
  /** Let the engine arrange the plate. When true, per-object positions are ignored. */
  arrange?: boolean;
  objects: PlateObject[];
}

/**
 * What to slice.
 *
 * `plates` is the preferred path: the client sends geometry references plus transforms
 * and the server writes the engine's plate description, so no client-side 3MF authoring
 * is needed. `models` is the plain "here are some STLs/3MFs" fallback.
 */
export type JobInput =
  { kind: 'plates'; plates: PlateSpec[] } | { kind: 'models'; models: ModelRef[] };

/** The body of `POST /jobs`, sent as the `descriptor` multipart field (JSON). */
export interface JobRequest {
  /** Free-text label shown in the UI. */
  name?: string;
  printer: PresetRef;
  process: PresetRef;
  /** At least one. Slot N of the plate objects' `filaments` is `filaments[N - 1]`. */
  filaments: PresetRef[];
  /** Per-slot colours, `#RRGGBB`. Optional; see SPEC deviation #3. */
  filamentColours?: string[];
  /** 0 = every plate (the default), N = plate N only. */
  plate?: number;
  /**
   * Raw config-key overrides applied with the highest priority, e.g.
   * `{ layer_height: 0.28 }`. M6 drives this; M1 only has to carry it.
   */
  overrides?: Record<string, string | number | boolean>;
  input: JobInput;
}

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** The server restarted while this job was queued or running. */
  | 'interrupted';

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

/** A stored model in the content-addressed library. */
export interface ModelSummary {
  /** `sha256:<hex>`; also the storage key. */
  id: string;
  filename: string;
  bytes: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface ArtifactSummary {
  /** Path-safe file name, the `:name` in `GET /jobs/:id/artifacts/:name`. */
  name: string;
  bytes: number;
  contentType: string;
  /** What this artefact is, so a client need not pattern-match on the name. */
  role: 'project' | 'gcode';
  /** 1-based plate this artefact belongs to, when it is plate-specific. */
  plate?: number;
}

/** Per-filament usage, straight out of the engine's own slice report. */
export interface FilamentUsage {
  /** 1-based slot. */
  id: number;
  type: string | null;
  colour: string | null;
  usedMetres: number;
  usedGrams: number;
}

export interface PlateStats {
  index: number;
  /** Estimated print time in seconds. */
  predictionSeconds: number;
  /** Total filament mass in grams. */
  weightGrams: number;
  layerCount: number | null;
  filaments: FilamentUsage[];
  /** True when the engine reported objects outside the printable area. */
  outside: boolean;
  supportUsed: boolean;
}

/**
 * The results panel's data.
 *
 * NOTE (SPEC verified deviation #6): `first_layer_time` in the engine's report is
 * uninitialised garbage and is deliberately not surfaced here.
 */
export interface SliceStats {
  predictionSeconds: number;
  weightGrams: number;
  totalMetres: number;
  layerCount: number | null;
  plates: PlateStats[];
}

export interface JobSummary {
  id: string;
  name: string | null;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 0–100, last observed. */
  percent: number;
  message: string | null;
  /** Engine warnings collected so far; the user's only signal for e.g. unsupported overhangs. */
  warnings: string[];
  /** Content ids of every model the job used, for a re-slice with no re-upload. */
  models: ModelSummary[];
  artifacts: ArtifactSummary[];
  stats: SliceStats | null;
  error: ApiError | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Engine-agnostic failure vocabulary. Adapters map their own exit codes and
 * diagnostics onto this; a raw exit code or stderr dump never reaches the client.
 */
export type SliceErrorCode =
  | 'INVALID_PARAMS'
  | 'INPUT_NOT_FOUND'
  | 'INPUT_UNREADABLE'
  | 'PROFILE_INVALID'
  | 'PROFILE_INCOMPATIBLE'
  | 'FILAMENT_INCOMPATIBLE'
  | 'RELATIVE_E_RESET_REQUIRED'
  | 'NO_PRINTABLE_OBJECTS'
  | 'OBJECT_OUTSIDE_BED'
  | 'OBJECT_COLLISION'
  | 'GCODE_CONFLICT'
  | 'SLICING_FAILED'
  | 'EXPORT_FAILED'
  | 'ARTIFACT_MISSING'
  | 'OUT_OF_MEMORY'
  | 'LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'ENGINE_CRASHED'
  | 'ENVIRONMENT_ERROR'
  | 'UNSUPPORTED_OPERATION';

/** API-level codes that are not slice failures. */
export type ApiErrorCode =
  | SliceErrorCode
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'QUOTA_EXCEEDED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

/** The body of every non-2xx response, and of the SSE `failed` event. */
export interface ApiError {
  code: ApiErrorCode;
  /** Safe to show a user verbatim. */
  message: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** Whether resubmitting the same job unchanged could plausibly succeed. */
  retryable: boolean;
}

export interface ApiErrorResponse {
  error: ApiError;
}

// ---------------------------------------------------------------------------
// SSE events — `GET /jobs/:id/events`
// ---------------------------------------------------------------------------

/** Sent on connect and whenever the job changes state. */
export interface JobStateEvent {
  type: 'state';
  jobId: string;
  state: JobState;
  at: string;
}

/** Throttled to roughly one per second by the engine adapter; warnings are never throttled away. */
export interface JobProgressEvent {
  type: 'progress';
  jobId: string;
  /** 0–100 across all plates. */
  percent: number;
  plateIndex: number;
  plateCount: number;
  platePercent: number;
  message: string;
  warning: string | null;
  at: string;
}

export interface JobDoneEvent {
  type: 'done';
  jobId: string;
  job: JobSummary;
  at: string;
}

export interface JobFailedEvent {
  type: 'failed';
  jobId: string;
  error: ApiError;
  at: string;
}

export type JobEvent = JobStateEvent | JobProgressEvent | JobDoneEvent | JobFailedEvent;

/** `event:` field name used for each SSE frame. Terminal events close the stream. */
export const JOB_EVENT_NAMES = ['state', 'progress', 'done', 'failed'] as const;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** `POST /jobs` → 202. */
export interface CreateJobResponse {
  id: string;
  state: JobState;
  models: ModelSummary[];
  links: {
    self: string;
    events: string;
    artifacts: string;
  };
}

/** `POST /models` → 201. */
export interface UploadModelsResponse {
  models: ModelSummary[];
}

/** `GET /healthz`. */
export interface HealthResponse {
  ok: boolean;
  engine: { id: string; version: string };
  queue: { driver: string; concurrency: number; queued: number; running: number };
  /**
   * Which `ProfileResolver` is wired in, and what the generated catalog behind it holds.
   * `catalog` is `null` when the server started without the generated artefacts — the
   * preset routes are then unavailable and slicing can only use an injected resolver.
   */
  profiles: {
    resolver: string;
    catalog: {
      orcaVersion: string;
      vendors: number;
      printerModels: number;
      presets: number;
    } | null;
  };
}
