/**
 * The three calls the G-code preview makes.
 *
 * The contract is docs/GCODE-PREVIEW-FORMAT.md:
 *
 *   GET /jobs/:id/preview              which plates can be previewed
 *   GET /jobs/:id/preview/:plate       the layer index (JSON; compiles on first request)
 *   GET /jobs/:id/preview/:plate/data  the layer chunks, byte-range addressable
 *
 * The whole design of this milestone rests on the third one being a **range** request. A
 * 26 MiB `.bin` is not something a phone downloads to show twenty layers, and both
 * responses are `immutable`-cached for a year, so scrubbing back over layers already seen
 * costs no network at all.
 */

import type { PreviewIndex } from '@orca-web/gcode';
import { API_BASE, ApiFailure, apiFetch, getJson, offlineFailure } from './http.ts';

export interface PreviewPlateLink {
  plate: number;
  links: { index: string; data: string };
}

export interface PreviewPlates {
  jobId: string;
  state: string;
  plates: PreviewPlateLink[];
}

export function fetchPreviewPlates(jobId: string): Promise<PreviewPlates> {
  return getJson<PreviewPlates>(`/jobs/${jobId}/preview`);
}

export function fetchPreviewIndex(jobId: string, plate: number): Promise<PreviewIndex> {
  return getJson<PreviewIndex>(`/jobs/${jobId}/preview/${plate}`);
}

export function previewDataUrl(jobId: string, plate: number): string {
  return `${API_BASE}/jobs/${jobId}/preview/${plate}/data`;
}

/**
 * One layer window, as raw bytes.
 *
 * `Range` is inclusive at both ends, which is why the caller passes `end` rather than a
 * length — off-by-one here is a whole extra segment record spliced onto the last layer,
 * and it draws as a line across the plate rather than as an error.
 *
 * A server that ignored `Range` would answer 200 with the entire `.bin`; that is the one
 * case worth being defensive about, because the failure mode is a 26 MB allocation on a
 * phone rather than a wrong picture. The slice is a copy, and it is the cheap price of
 * never trusting the network to have honoured a header.
 */
export async function fetchLayerBytes(
  jobId: string,
  plate: number,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = previewDataUrl(jobId, plate);
  const init: RequestInit = { headers: { Range: `bytes=${start}-${end}` } };
  if (signal) init.signal = signal;

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw offlineFailure(cause);
  }
  if (!response.ok) {
    // Reuse the shared error contract rather than inventing wording here.
    return apiFetch(`/jobs/${jobId}/preview/${plate}/data`, init).then((ok) => ok.arrayBuffer());
  }
  const body = await response.arrayBuffer();
  if (response.status === 206) return body;
  if (body.byteLength >= end + 1) return body.slice(start, end + 1);
  throw new ApiFailure(
    {
      code: 'INTERNAL',
      message: 'The preview data came back in a shape this browser cannot use.',
      hint: 'The server must answer a Range request with 206 Partial Content.',
      retryable: false,
    },
    response.status,
  );
}
