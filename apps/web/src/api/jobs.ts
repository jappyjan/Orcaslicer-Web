/**
 * Uploads, job submission and the progress stream.
 *
 * The upload is deliberately its own request (`POST /models`) rather than a file part on
 * `POST /jobs`. `models[].id` is a `sha256:` content id, so once a model is in the
 * library every later slice of it — different filament, different layer height, an hour
 * later — costs one small JSON request and no re-upload. On a phone on mobile data that
 * is the difference between "slice again" being instant and being a minute of uploading.
 * It is a settled product decision (docs/SPEC.md, "Model storage"), not an optimisation.
 */

import type {
  ApiError,
  CreateJobResponse,
  JobEvent,
  JobRequest,
  JobSummary,
  ModelSummary,
  UploadModelsResponse,
} from '@orca-web/shared';
import { API_BASE, ApiFailure, apiFetch, getJson, offlineFailure } from './http.ts';

/**
 * Upload one model into the content-addressed library.
 *
 * `XMLHttpRequest`, not `fetch`, purely for `upload.onprogress`: fetch still cannot
 * report upload progress, and a 200 MB STL over mobile data with no feedback looks
 * exactly like a hang.
 */
export function uploadModel(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ModelSummary> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('files', file, file.name);

    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE}/models`);
    request.responseType = 'text';

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.responseText) as unknown;
      } catch {
        parsed = undefined;
      }
      if (request.status >= 200 && request.status < 300) {
        const body = parsed as UploadModelsResponse | undefined;
        const model = body?.models?.[0];
        if (!model) {
          reject(
            new ApiFailure(
              {
                code: 'INTERNAL',
                message: 'The server accepted the file but returned no model.',
                retryable: true,
              },
              request.status,
            ),
          );
          return;
        }
        onProgress(1);
        resolve(model);
        return;
      }
      const error = (parsed as { error?: ApiError } | undefined)?.error;
      reject(
        new ApiFailure(
          error ?? {
            code: 'INTERNAL',
            message: `The upload failed (${request.status}).`,
            retryable: request.status >= 500,
          },
          request.status,
        ),
      );
    });

    request.addEventListener('error', () => reject(offlineFailure(undefined)));
    request.addEventListener('abort', () =>
      reject(
        new ApiFailure({ code: 'CANCELLED', message: 'Upload cancelled.', retryable: true }, 0),
      ),
    );
    signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(form);
  });
}

/**
 * `POST /jobs` with only the descriptor field.
 *
 * Multipart with no file parts is intentional: every model reference is
 * `{ source: 'library', id }`, so there is nothing to send but the JSON.
 */
export async function createJob(descriptor: JobRequest): Promise<CreateJobResponse> {
  const form = new FormData();
  form.append('descriptor', JSON.stringify(descriptor));
  const response = await apiFetch('/jobs', { method: 'POST', body: form });
  return (await response.json()) as CreateJobResponse;
}

export function fetchJob(id: string): Promise<JobSummary> {
  return getJson<JobSummary>(`/jobs/${id}`);
}

export async function cancelJob(id: string): Promise<void> {
  await apiFetch(`/jobs/${id}`, { method: 'DELETE' });
}

export function artifactUrl(jobId: string, name: string): string {
  return `${API_BASE}/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`;
}

/**
 * Subscribe to `GET /jobs/:id/events`.
 *
 * `EventSource` is the right tool here and not just the convenient one: it reconnects on
 * its own and replays with `Last-Event-ID`, which the server honours from its buffer —
 * so a phone that loses signal mid-slice rejoins without losing events. Two details it
 * gets wrong for us, both handled below:
 *
 *  - the server closes the stream after `done`/`failed`, and EventSource treats a closed
 *    stream as an error and reconnects. We close it ourselves on the terminal event.
 *  - a genuine connection failure is indistinguishable from that at the API level, so a
 *    failure that persists falls back to polling `GET /jobs/:id` rather than leaving the
 *    UI stuck on a progress bar for ever.
 */
export interface JobStreamHandlers {
  onEvent: (event: JobEvent) => void;
  /** Called when the stream gave up and polling took over. */
  onDegraded?: () => void;
  onError?: (error: ApiError) => void;
}

const POLL_INTERVAL_MS = 3000;

export function subscribeToJob(jobId: string, handlers: JobStreamHandlers): () => void {
  let closed = false;
  let poller: ReturnType<typeof setInterval> | undefined;
  const source = new EventSource(`${API_BASE}/jobs/${jobId}/events`);

  const stop = (): void => {
    if (closed) return;
    closed = true;
    source.close();
    if (poller !== undefined) clearInterval(poller);
  };

  const deliver = (raw: MessageEvent<string>): void => {
    if (closed) return;
    let event: JobEvent;
    try {
      event = JSON.parse(raw.data) as JobEvent;
    } catch {
      return;
    }
    handlers.onEvent(event);
    if (event.type === 'done' || event.type === 'failed') stop();
  };

  for (const name of ['state', 'progress', 'done', 'failed'] as const) {
    source.addEventListener(name, deliver as EventListener);
  }

  source.addEventListener('error', () => {
    // CONNECTING means EventSource is retrying by itself; leave it alone. CLOSED with no
    // terminal event means it has given up, so poll instead.
    if (closed || source.readyState !== EventSource.CLOSED) return;
    handlers.onDegraded?.();
    poller = setInterval(() => {
      void fetchJob(jobId).then(
        (job) => {
          if (closed) return;
          handlers.onEvent({
            type: 'state',
            jobId,
            state: job.state,
            at: new Date().toISOString(),
          });
          if (job.state === 'succeeded') {
            handlers.onEvent({ type: 'done', jobId, job, at: new Date().toISOString() });
            stop();
          } else if (job.state !== 'queued' && job.state !== 'running') {
            handlers.onEvent({
              type: 'failed',
              jobId,
              error: job.error ?? {
                code: 'SLICING_FAILED',
                message: `The job ended as "${job.state}".`,
                retryable: true,
              },
              at: new Date().toISOString(),
            });
            stop();
          }
        },
        (error: unknown) => {
          if (error instanceof ApiFailure && error.status !== 0) {
            handlers.onError?.(error.error);
            stop();
          }
        },
      );
    }, POLL_INTERVAL_MS);
  });

  return stop;
}
