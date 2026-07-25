/**
 * The `SlicerEngine` port (hard constraint #3).
 *
 * This file is the boundary. Nothing in it may mention OrcaSlicer, a CLI flag, a
 * `.gcode.3mf`, or an exit code — those live in `engine/orca/`, and nothing outside
 * that directory imports from it. See docs/adr/0001-slicer-engine-boundary.md.
 */

import type { ResolvedProfile, SliceStats } from '@orca-web/shared';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One object (and its copies) placed on a plate. Paths are absolute and readable by the engine. */
export interface EngineObject {
  path: string;
  /** Number of copies. */
  count: number;
  /** 1-based filament slot per copy. Length 1 (applies to all) or `count`. */
  filaments: number[];
  /** Objects sharing a value are merged into one composed model. Length 1 or `count`. */
  assembleIndex: number[];
  /** Only honoured when the plate is not auto-arranged. */
  posX?: number[];
  posY?: number[];
  posZ?: number[];
  subtype: 'ModelPart' | 'NegativeVolume' | 'ParameterModifier';
  printParams: Record<string, string | number | boolean>;
  heightRanges: Array<{
    minZ: number;
    maxZ: number;
    rangeParams: Record<string, string | number | boolean>;
  }>;
}

export interface EnginePlate {
  /** 1-based. */
  index: number;
  name: string;
  /** When true the engine arranges the plate and per-object positions are ignored. */
  arrange: boolean;
  objects: EngineObject[];
}

/**
 * Geometry for a slice.
 *
 * `plates` is the structured path (positions, copies, filament slots, composition);
 * `files` is "slice these files as they are", for a project file or a bare STL.
 */
export type EngineInput =
  { kind: 'plates'; plates: EnginePlate[] } | { kind: 'files'; paths: string[] };

/** Guard rails the adapter must enforce, expressed as intent rather than as flags. */
export interface SliceLimits {
  /** Hard wall-clock deadline for the whole slice. */
  wallClockMs: number;
  /** Per-plate compute budget, if the engine can enforce one itself. */
  maxSecondsPerPlate: number;
  /** Per-plate geometry budget, if the engine can enforce one itself. */
  maxTrianglesPerPlate: number;
}

/** Everything an engine needs to produce artefacts. Fully engine-agnostic. */
export interface SliceJob {
  id: string;
  /**
   * A disposable directory the engine may fill with intermediates. It is created and
   * `rm -rf`ed by the caller (hard constraint #4); the engine never cleans it up and
   * never writes outside it.
   */
  workDir: string;
  input: EngineInput;
  /**
   * Profiles with their inheritance chains ALREADY FLATTENED. Passing a raw preset is a
   * programming error, not a slice error — see SPEC verified deviation #1.
   */
  machine: ResolvedProfile;
  process: ResolvedProfile;
  filaments: ResolvedProfile[];
  /** Per-slot colours, `#RRGGBB`. */
  filamentColours?: string[];
  /** 0 = all plates. */
  plate: number;
  /** Raw config-key overrides, applied at the highest priority. */
  overrides: Record<string, string | number | boolean>;
  limits: SliceLimits;
}

export interface SliceOptions {
  /** Aborting cancels the slice; the adapter must terminate its work promptly. */
  signal?: AbortSignal;
  /** Minimum gap between forwarded progress updates. Warnings bypass it. */
  progressIntervalMs?: number;
  /** Engine-internal diagnostics. Never surfaced to a user. */
  onLog?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface SliceProgress {
  /** 0 when the update concerns the whole job rather than one plate. */
  plateIndex: number;
  plateCount: number;
  /** 0–100 within the current plate. */
  platePercent: number;
  /** 0–100 across the job. */
  totalPercent: number;
  message: string;
  /**
   * An engine warning (e.g. unsupported overhangs). The user's only signal for a
   * whole class of problems, so it is never dropped by throttling.
   */
  warning: string | null;
}

export interface EngineArtifact {
  /** Path-safe file name, unique within the job. */
  name: string;
  /** Absolute path, inside the job's work directory. */
  path: string;
  bytes: number;
  contentType: string;
  role: 'project' | 'gcode';
  /** 1-based plate, when the artefact belongs to one. */
  plate?: number;
}

export interface SliceArtifacts {
  files: EngineArtifact[];
  stats: SliceStats;
  /** Distinct warnings observed during the slice, in order of first appearance. */
  warnings: string[];
}

export interface EngineInfo {
  id: string;
  /** The engine's own reported version, read from the binary rather than assumed. */
  version: string;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * `slice(job): AsyncIterable<Progress> -> Artifacts`.
 *
 * Expressed as an async generator: iterating yields progress, and the generator's
 * RETURN value is the artefacts. `for await` discards a generator's return value, so
 * callers use `runSlice()` (engine/run.ts) which drives the iterator by hand.
 *
 * Calling `.return()` on the iterator (or aborting `options.signal`) must cancel the
 * underlying work and release every resource the adapter allocated.
 */
export interface SlicerEngine {
  readonly id: string;
  probe(): Promise<EngineInfo>;
  slice(job: SliceJob, options?: SliceOptions): AsyncGenerator<SliceProgress, SliceArtifacts, void>;
}
