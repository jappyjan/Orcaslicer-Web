/**
 * One place that decides what a failure looks like on the wire.
 *
 * Every non-2xx response has the same body — `{ "error": { code, message, hint?,
 * retryable } }` — and `message` is always something a person can read. Raw stderr,
 * stack traces and exit codes stay in the server log.
 */

import type { ApiError, ApiErrorCode, SliceErrorCode } from '@orca-web/shared';
import { NotImplementedError, isSliceError } from '../engine/errors.js';
import { BadRequestError, NotFoundError } from '../jobs/job-service.js';
import { ProfileNotFoundError, ProfileResolutionError } from '../profiles/port.js';
import { QuotaExceededError } from '../storage/model-store.js';

/** HTTP status per slice-failure code: is this the user's fault or ours? */
const SLICE_STATUS: Record<SliceErrorCode, number> = {
  INVALID_PARAMS: 400,
  INPUT_NOT_FOUND: 404,
  INPUT_UNREADABLE: 400,
  PROFILE_INVALID: 400,
  PROFILE_INCOMPATIBLE: 400,
  FILAMENT_INCOMPATIBLE: 400,
  RELATIVE_E_RESET_REQUIRED: 400,
  NO_PRINTABLE_OBJECTS: 400,
  OBJECT_OUTSIDE_BED: 400,
  OBJECT_COLLISION: 400,
  GCODE_CONFLICT: 400,
  SLICING_FAILED: 422,
  EXPORT_FAILED: 500,
  ARTIFACT_MISSING: 500,
  OUT_OF_MEMORY: 507,
  LIMIT_EXCEEDED: 413,
  TIMEOUT: 504,
  CANCELLED: 409,
  ENGINE_CRASHED: 500,
  ENVIRONMENT_ERROR: 500,
  UNSUPPORTED_OPERATION: 400,
};

export interface HttpFailure {
  status: number;
  body: { error: ApiError };
  /** Server-side only. */
  detail: string | undefined;
}

function error(code: ApiErrorCode, message: string, retryable: boolean, hint?: string): ApiError {
  return { code, message, ...(hint === undefined ? {} : { hint }), retryable };
}

export function toHttpFailure(cause: unknown): HttpFailure {
  if (isSliceError(cause)) {
    return {
      status: SLICE_STATUS[cause.code] ?? 500,
      body: { error: cause.toApiError() },
      detail: cause.detail,
    };
  }
  if (cause instanceof BadRequestError) {
    return {
      status: 400,
      body: { error: error('BAD_REQUEST', cause.message, false, cause.hint) },
      detail: undefined,
    };
  }
  if (cause instanceof NotFoundError || cause instanceof ProfileNotFoundError) {
    return {
      status: 404,
      body: { error: error('NOT_FOUND', cause.message, false) },
      detail: undefined,
    };
  }
  if (cause instanceof ProfileResolutionError) {
    return {
      status: 400,
      body: {
        error: error(
          'PROFILE_INVALID',
          'That preset could not be loaded.',
          false,
          'Choose a different preset.',
        ),
      },
      detail: cause.message,
    };
  }
  if (cause instanceof QuotaExceededError) {
    return {
      status: 413,
      body: {
        error: error(
          'QUOTA_EXCEEDED',
          'The model library is full.',
          true,
          'Delete some models, or ask the operator to raise MODEL_LIBRARY_MAX_BYTES.',
        ),
      },
      detail: cause.message,
    };
  }
  if (cause instanceof NotImplementedError) {
    return {
      status: 501,
      body: { error: error('NOT_IMPLEMENTED', cause.message, false) },
      detail: cause.message,
    };
  }

  const isPayloadTooLarge =
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE';
  if (isPayloadTooLarge) {
    return {
      status: 413,
      body: {
        error: error('PAYLOAD_TOO_LARGE', 'That file is larger than this server accepts.', false),
      },
      detail: String(cause),
    };
  }

  return {
    status: 500,
    body: { error: error('INTERNAL', 'Something went wrong on the server.', true) },
    detail: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  };
}
