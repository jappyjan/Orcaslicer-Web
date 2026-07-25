/**
 * OrcaSlicer CLI exit codes → typed errors.
 *
 * The constants are `CLI_*` in upstream `src/libslic3r/Utils.hpp` (verified against tag
 * v2.4.2, the version pinned in the Dockerfile), and the descriptions come from the
 * `cli_errors` table in `src/OrcaSlicer.cpp`. Upstream's own strings are written for a
 * Bambu upload pipeline ("...before uploading"), so we do not forward them: every code
 * gets our own user-facing message plus a hint, and upstream's text stays in `detail`.
 *
 * MEASURED (not in SPEC.md): `main()` returns the negative constant and the shell sees
 * it truncated to 8 bits, so `-3` arrives as exit status 253, `-5` as 251, `-13` as 243.
 * Any mapping that compares the raw status against the upstream table without undoing
 * that truncation silently matches nothing.
 */

import type { SliceErrorCode } from '@orca-web/shared';
import { SliceError } from '../errors.js';

export interface ExitCodeEntry {
  /** The upstream constant name, for logs and for the next person diffing Utils.hpp. */
  symbol: string;
  code: SliceErrorCode;
  message: string;
  hint?: string;
  retryable?: boolean;
}

/** Keyed by the *signed* upstream value, not by the 8-bit exit status. */
export const ORCA_EXIT_CODES: ReadonlyMap<number, ExitCodeEntry> = new Map<number, ExitCodeEntry>([
  [
    -1,
    {
      symbol: 'CLI_ENVIRONMENT_ERROR',
      code: 'ENVIRONMENT_ERROR',
      message: 'The slicer could not start.',
      hint: 'This is a server-side problem, not a problem with your model.',
      retryable: true,
    },
  ],
  [
    -2,
    {
      symbol: 'CLI_INVALID_PARAMS',
      code: 'INVALID_PARAMS',
      message: 'The slicer rejected the settings for this job.',
      hint: 'Check any overridden settings; one of them is not a valid value.',
    },
  ],
  [
    -3,
    {
      symbol: 'CLI_FILE_NOTFOUND',
      code: 'INPUT_NOT_FOUND',
      message: 'A model file for this job could not be found.',
      hint: 'Re-upload the model and try again.',
    },
  ],
  [
    -4,
    {
      symbol: 'CLI_FILELIST_INVALID_ORDER',
      code: 'INVALID_PARAMS',
      message: 'The model files were supplied in an order the slicer cannot use.',
      hint: 'When a project file (.3mf) is included it must be the first model.',
    },
  ],
  [
    -5,
    {
      symbol: 'CLI_CONFIG_FILE_ERROR',
      code: 'PROFILE_INVALID',
      message: 'A printer, process or filament profile could not be read.',
      hint: 'Pick a different preset; this one is malformed.',
    },
  ],
  [
    -6,
    {
      symbol: 'CLI_DATA_FILE_ERROR',
      code: 'INPUT_UNREADABLE',
      message: 'The model file could not be parsed.',
      hint: 'Export the model again — the file looks corrupt or is not a supported format.',
    },
  ],
  [
    -7,
    {
      symbol: 'CLI_INVALID_PRINTER_TECH',
      code: 'PROFILE_INCOMPATIBLE',
      message: 'That printer is not an FDM printer, which is all this service supports.',
    },
  ],
  [
    -8,
    {
      symbol: 'CLI_UNSUPPORTED_OPERATION',
      code: 'UNSUPPORTED_OPERATION',
      message: 'The slicer does not support this combination of options.',
    },
  ],
  [
    -9,
    {
      symbol: 'CLI_COPY_OBJECTS_ERROR',
      code: 'SLICING_FAILED',
      message: 'The slicer could not duplicate one of the objects.',
      hint: 'Reduce the number of copies.',
    },
  ],
  [
    -10,
    {
      symbol: 'CLI_SCALE_TO_FIT_ERROR',
      code: 'OBJECT_OUTSIDE_BED',
      message: 'An object could not be scaled to fit the build plate.',
      hint: 'Scale the model down or choose a printer with a larger bed.',
    },
  ],
  [
    -11,
    {
      symbol: 'CLI_EXPORT_STL_ERROR',
      code: 'EXPORT_FAILED',
      message: 'Exporting the model failed.',
      retryable: true,
    },
  ],
  [
    -12,
    {
      symbol: 'CLI_EXPORT_OBJ_ERROR',
      code: 'EXPORT_FAILED',
      message: 'Exporting the model failed.',
      retryable: true,
    },
  ],
  [
    -13,
    {
      symbol: 'CLI_EXPORT_3MF_ERROR',
      code: 'EXPORT_FAILED',
      message: 'The slice finished but the result could not be written.',
      hint: 'This is a server-side problem; try again.',
      retryable: true,
    },
  ],
  [
    -14,
    {
      symbol: 'CLI_OUT_OF_MEMORY',
      code: 'OUT_OF_MEMORY',
      message: 'The server ran out of memory slicing this model.',
      hint: 'Simplify the model or reduce its triangle count and try again.',
    },
  ],
  [
    -15,
    {
      symbol: 'CLI_3MF_NOT_SUPPORT_MACHINE_CHANGE',
      code: 'PROFILE_INCOMPATIBLE',
      message: 'This project cannot be re-targeted to the selected printer.',
      hint: 'Slice it with the printer it was created for, or upload the model instead of the project.',
    },
  ],
  [
    -16,
    {
      symbol: 'CLI_3MF_NEW_MACHINE_NOT_SUPPORTED',
      code: 'PROFILE_INCOMPATIBLE',
      message: 'The selected printer is not compatible with the uploaded project file.',
      hint: 'Choose the printer the project was made for.',
    },
  ],
  [
    -17,
    {
      symbol: 'CLI_PROCESS_NOT_COMPATIBLE',
      code: 'PROFILE_INCOMPATIBLE',
      message: 'The selected print process does not work with the selected printer.',
      hint: 'Pick a process preset made for this printer and nozzle size.',
    },
  ],
  [
    -18,
    {
      symbol: 'CLI_INVALID_VALUES_IN_3MF',
      code: 'INPUT_UNREADABLE',
      message: 'The uploaded project file contains invalid settings.',
      hint: 'Re-export it from OrcaSlicer, or upload the model on its own.',
    },
  ],
  [
    -19,
    {
      symbol: 'CLI_POSTPROCESS_NOT_SUPPORTED',
      code: 'UNSUPPORTED_OPERATION',
      message: 'Post-processing scripts cannot be run by this service.',
      hint: 'Remove the post-processing script from the print profile.',
    },
  ],
  [
    -20,
    {
      symbol: 'CLI_PRINTABLE_SIZE_REDUCED',
      code: 'PROFILE_INCOMPATIBLE',
      message: "The print profile expects a larger bed than the selected printer's.",
      hint: 'Choose a process preset for this printer.',
    },
  ],
  [
    -21,
    {
      symbol: 'CLI_OBJECT_ARRANGE_FAILED',
      code: 'OBJECT_OUTSIDE_BED',
      message: 'The objects could not be arranged on the plate.',
      hint: 'Remove an object, or place them yourself instead of auto-arranging.',
    },
  ],
  [
    -22,
    {
      symbol: 'CLI_OBJECT_ORIENT_FAILED',
      code: 'SLICING_FAILED',
      message: 'The objects could not be auto-oriented.',
    },
  ],
  [
    -23,
    {
      symbol: 'CLI_MODIFIED_PARAMS_TO_PRINTER',
      code: 'PROFILE_INCOMPATIBLE',
      message: 'The uploaded project changes printer settings that must not be changed.',
      hint: 'Re-export the project without modified printer settings.',
    },
  ],
  [
    -24,
    {
      symbol: 'CLI_FILE_VERSION_NOT_SUPPORTED',
      code: 'INPUT_UNREADABLE',
      message: 'That project file was written by an unsupported slicer version.',
      hint: 'Re-export it from a released version of OrcaSlicer.',
    },
  ],
  [
    -50,
    {
      symbol: 'CLI_NO_SUITABLE_OBJECTS',
      code: 'NO_PRINTABLE_OBJECTS',
      message: 'The plate is empty, or nothing on it is fully inside the printable area.',
      hint: 'Move the objects onto the plate and slice again.',
    },
  ],
  [
    -51,
    {
      symbol: 'CLI_VALIDATE_ERROR',
      code: 'PROFILE_INVALID',
      message: 'The print settings are not valid for this printer.',
      hint: 'Reset the modified settings or choose a stock preset.',
    },
  ],
  [
    -52,
    {
      symbol: 'CLI_OBJECTS_PARTLY_INSIDE',
      code: 'OBJECT_OUTSIDE_BED',
      message: 'Some objects hang over the edge of the build plate.',
      hint: 'Move or scale them so they sit fully on the plate.',
    },
  ],
  [
    -53,
    {
      symbol: 'CLI_EXPORT_CACHE_DIRECTORY_CREATE_FAILED',
      code: 'EXPORT_FAILED',
      message: 'The slicer could not write its working files.',
      retryable: true,
    },
  ],
  [
    -54,
    {
      symbol: 'CLI_EXPORT_CACHE_WRITE_FAILED',
      code: 'EXPORT_FAILED',
      message: 'The slicer could not write its working files.',
      retryable: true,
    },
  ],
  [
    -55,
    {
      symbol: 'CLI_IMPORT_CACHE_NOT_FOUND',
      code: 'INPUT_NOT_FOUND',
      message: 'Cached slice data referenced by this job is missing.',
      retryable: true,
    },
  ],
  [
    -56,
    {
      symbol: 'CLI_IMPORT_CACHE_DATA_CAN_NOT_USE',
      code: 'INPUT_UNREADABLE',
      message: 'Cached slice data referenced by this job could not be read.',
      retryable: true,
    },
  ],
  [
    -57,
    {
      symbol: 'CLI_IMPORT_CACHE_LOAD_FAILED',
      code: 'INPUT_UNREADABLE',
      message: 'Cached slice data referenced by this job could not be loaded.',
      retryable: true,
    },
  ],
  [
    -58,
    {
      symbol: 'CLI_SLICING_TIME_EXCEEDS_LIMIT',
      code: 'LIMIT_EXCEEDED',
      message: 'Slicing one of the plates took longer than this server allows.',
      hint: 'Use a larger layer height, or simplify the model.',
    },
  ],
  [
    -59,
    {
      symbol: 'CLI_TRIANGLE_COUNT_EXCEEDS_LIMIT',
      code: 'LIMIT_EXCEEDED',
      message: 'The model has more triangles than this server allows on one plate.',
      hint: 'Decimate the mesh before uploading it.',
    },
  ],
  [
    -60,
    {
      symbol: 'CLI_NO_SUITABLE_OBJECTS_AFTER_SKIP',
      code: 'NO_PRINTABLE_OBJECTS',
      message: 'Nothing is left to print once the skipped objects are removed.',
    },
  ],
  [
    -61,
    {
      symbol: 'CLI_FILAMENT_NOT_MATCH_BED_TYPE',
      code: 'FILAMENT_INCOMPATIBLE',
      message: 'The chosen filament cannot be printed on this plate type.',
      hint: 'Choose a different plate type or a different filament.',
    },
  ],
  [
    -62,
    {
      symbol: 'CLI_FILAMENTS_DIFFERENT_TEMP',
      code: 'FILAMENT_INCOMPATIBLE',
      message: 'The chosen filaments need temperatures too far apart to print together.',
      hint: 'Use filaments with similar nozzle temperatures.',
    },
  ],
  [
    -63,
    {
      symbol: 'CLI_OBJECT_COLLISION_IN_SEQ_PRINT',
      code: 'OBJECT_COLLISION',
      message: 'Objects collide when printing one at a time.',
      hint: 'Move the objects further apart, or turn off print-by-object.',
    },
  ],
  [
    -64,
    {
      symbol: 'CLI_OBJECT_COLLISION_IN_LAYER_PRINT',
      code: 'OBJECT_COLLISION',
      message: 'Objects on the plate collide.',
      hint: 'Move the objects further apart.',
    },
  ],
  [
    -65,
    {
      symbol: 'CLI_SPIRAL_MODE_INVALID_PARAMS',
      code: 'PROFILE_INVALID',
      message: 'Some settings cannot be used together with Spiral Vase mode.',
      hint: 'Turn Spiral Vase off, or use a preset built for it.',
    },
  ],
  [
    -66,
    {
      symbol: 'CLI_FILAMENT_CAN_NOT_MAP',
      code: 'FILAMENT_INCOMPATIBLE',
      message: 'The filaments could not be assigned to the printer’s extruders.',
      hint: 'Reduce the number of filament slots.',
    },
  ],
  [
    -67,
    {
      symbol: 'CLI_ONLY_ONE_TPU_SUPPORTED',
      code: 'FILAMENT_INCOMPATIBLE',
      message: 'Only one TPU filament can be used at a time.',
    },
  ],
  [
    -68,
    {
      symbol: 'CLI_FILAMENTS_NOT_SUPPORTED_BY_EXTRUDER',
      code: 'FILAMENT_INCOMPATIBLE',
      message: 'One of the filaments cannot be printed by the extruder it was assigned to.',
    },
  ],
  [
    -100,
    {
      symbol: 'CLI_SLICING_ERROR',
      code: 'SLICING_FAILED',
      message: 'The model could not be sliced.',
      hint: 'Check the model for holes or non-manifold geometry, or try different settings.',
    },
  ],
  [
    -101,
    {
      symbol: 'CLI_GCODE_PATH_CONFLICTS',
      code: 'GCODE_CONFLICT',
      message: 'The generated toolpaths collide.',
      hint: 'Move the objects further apart, or move the prime tower away from them.',
    },
  ],
  [
    -102,
    {
      symbol: 'CLI_GCODE_PATH_IN_UNPRINTABLE_AREA',
      code: 'GCODE_CONFLICT',
      message: 'Part of the toolpath ends up outside the printable area.',
      hint: 'Move the objects towards the middle of the plate.',
    },
  ],
]);

/**
 * Undo the 8-bit truncation a negative `main()` return suffers on the way to a shell.
 * 253 → -3, 251 → -5, 243 → -13. Statuses 0–127 are passed through unchanged.
 */
export function toSignedExitCode(status: number): number {
  return status > 127 ? status - 256 : status;
}

export function describeExitCode(status: number): ExitCodeEntry | undefined {
  return ORCA_EXIT_CODES.get(toSignedExitCode(status));
}

/**
 * Build the typed error for a non-zero exit. `detail` carries the engine's own output
 * for the log; it is never part of the client-facing message.
 */
export function sliceErrorForExit(status: number, detail: string): SliceError {
  const entry = describeExitCode(status);
  if (!entry) {
    return new SliceError('ENGINE_CRASHED', 'The slicer stopped unexpectedly.', {
      hint: 'Try again; if it keeps happening, report the job id.',
      retryable: true,
      detail: `exit status ${status} (signed ${toSignedExitCode(status)}) is not in the ${
        ORCA_EXIT_CODES.size
      }-entry CLI table\n${detail}`,
    });
  }
  return new SliceError(entry.code, entry.message, {
    ...(entry.hint === undefined ? {} : { hint: entry.hint }),
    retryable: entry.retryable ?? false,
    detail: `${entry.symbol} (${toSignedExitCode(status)})\n${detail}`,
  });
}
