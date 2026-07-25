/**
 * The typed error vocabulary that crosses the engine boundary.
 *
 * SPEC: "Exit codes are meaningful. Map them to typed errors; never show the user a
 * bare non-zero exit." A `SliceError` is the only failure shape an adapter is allowed
 * to throw, and it always carries a message a user can read. Engine diagnostics travel
 * in `detail`, which is logged and never returned over HTTP.
 */

import type { ApiError, ApiErrorCode, SliceErrorCode } from '@orca-web/shared';

export interface SliceErrorInit {
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** Whether resubmitting the same job unchanged could plausibly succeed. */
  retryable?: boolean;
  /** Raw engine output. Logged, never sent to a client. */
  detail?: string;
  cause?: unknown;
}

export class SliceError extends Error {
  readonly code: SliceErrorCode;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  readonly detail: string | undefined;

  constructor(code: SliceErrorCode, message: string, init: SliceErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'SliceError';
    this.code = code;
    this.hint = init.hint;
    this.retryable = init.retryable ?? false;
    this.detail = init.detail;
  }

  /** The client-facing projection. Deliberately drops `detail`. */
  toApiError(): ApiError {
    return {
      code: this.code as ApiErrorCode,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      retryable: this.retryable,
    };
  }
}

export function isSliceError(value: unknown): value is SliceError {
  return value instanceof SliceError;
}

/**
 * Last-resort conversion for anything that escaped an adapter without being typed.
 * The message is generic on purpose: an unexpected `Error` may contain paths or
 * engine internals that are not fit for a user.
 */
export function toSliceError(value: unknown): SliceError {
  if (isSliceError(value)) return value;
  const detail = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return new SliceError('ENGINE_CRASHED', 'The slicer failed unexpectedly.', {
    hint: 'Try again; if it keeps happening the model or the profile combination is likely at fault.',
    retryable: true,
    detail,
    cause: value,
  });
}

/** A queue or engine adapter that exists but is not finished. Never a silent no-op. */
export class NotImplementedError extends Error {
  constructor(what: string, missing: string) {
    super(`${what} is not yet implemented. Missing: ${missing}`);
    this.name = 'NotImplementedError';
  }
}
