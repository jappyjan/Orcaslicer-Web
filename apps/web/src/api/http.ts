/**
 * The one place that talks to the API's error contract.
 *
 * Every non-2xx response from the server is `{ error: { code, message, hint?, retryable } }`
 * and `message` is written to be shown to a person verbatim (`apps/api/src/http/errors.ts`).
 * So: never invent our own wording for a server failure, never swallow `hint` — it is the
 * only place the API says what to do about a 404 on an unknown printer or nozzle — and
 * carry `retryable` through so the UI can decide whether to offer "Try again".
 */

import type { ApiError, ApiErrorResponse } from '@orca-web/shared';

/** Same-origin in production (the API serves the bundle) and via Vite's proxy in dev. */
export const API_BASE = '';

export class ApiFailure extends Error {
  readonly error: ApiError;
  /** 0 when the request never reached the server. */
  readonly status: number;

  constructor(error: ApiError, status: number) {
    super(error.message);
    this.name = 'ApiFailure';
    this.error = error;
    this.status = status;
  }

  get hint(): string | undefined {
    return this.error.hint;
  }

  get retryable(): boolean {
    return this.error.retryable;
  }
}

/** A failure that never reached the server — offline, DNS, a dropped mobile connection. */
export function offlineFailure(cause: unknown): ApiFailure {
  return new ApiFailure(
    {
      code: 'INTERNAL',
      message: 'Could not reach the slice service.',
      hint: 'Check your connection and try again.',
      retryable: true,
    },
    0,
  );
  // `cause` is deliberately not surfaced: fetch's own messages ("Failed to fetch") are
  // not user-safe wording, and the console already has the original.
  void cause;
}

async function toFailure(response: Response): Promise<ApiFailure> {
  let error: ApiError | undefined;
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (body && typeof body === 'object' && body.error && typeof body.error.message === 'string') {
      error = body.error;
    }
  } catch {
    // Not JSON — fall through to the generic shape below.
  }
  return new ApiFailure(
    error ?? {
      code: 'INTERNAL',
      message: `The server returned an unexpected ${response.status} response.`,
      retryable: response.status >= 500,
    },
    response.status,
  );
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (cause) {
    throw offlineFailure(cause);
  }
  if (!response.ok) throw await toFailure(response);
  return response;
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  return (await response.json()) as T;
}

/** Turns anything thrown by this module — or by a component — into something showable. */
export function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiFailure) return cause.error;
  return {
    code: 'INTERNAL',
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
  };
}
