/**
 * The four calls the plater makes.
 *
 * Nothing here interprets a failure: `http.ts` owns the error contract, and the plater
 * shows what the server said.
 */

import type { ArrangeRequestBody, ArrangeResponse, BedSpec, PresetRef } from '@orca-web/shared';
import type { PrinterOption } from './catalog.ts';
import { API_BASE, apiFetch, getJson } from './http.ts';

/**
 * The build plate for a printer + nozzle.
 *
 * Cached per printer/nozzle for the session: it is derived from a preset that cannot
 * change without the image being rebuilt, and re-fetching it on every visit to the plater
 * would be a round trip in front of the first frame.
 */
const beds = new Map<string, Promise<BedSpec>>();

export function loadBed(printer: PrinterOption, nozzle: string): Promise<BedSpec> {
  const key = `${printer.vendorId}|${printer.name}|${nozzle}`;
  const cached = beds.get(key);
  if (cached) return cached;
  const query = new URLSearchParams({ model: printer.name, vendor: printer.vendorId, nozzle });
  const pending = getJson<BedSpec>(`/plater/bed?${query.toString()}`).catch((error: unknown) => {
    beds.delete(key);
    throw error;
  });
  beds.set(key, pending);
  return pending;
}

/** Test seam, and what a printer change invalidates. */
export function resetBedCache(): void {
  beds.clear();
}

/**
 * Where the model's bytes are.
 *
 * Content-addressed and served `immutable`, so the browser cache does the work: revisiting
 * the plater with the same model costs no network at all.
 */
export function modelFileUrl(modelId: string): string {
  return `${API_BASE}/models/${encodeURIComponent(modelId)}/file`;
}

export async function fetchModelFile(modelId: string): Promise<ArrayBuffer> {
  const response = await apiFetch(modelFileUrl(modelId));
  return response.arrayBuffer();
}

/**
 * Auto-arrange, server-side.
 *
 * SPEC: this delegates to the engine's own packer (`--arrange 1`). The client deliberately
 * has no bin packing in it — a second implementation would disagree with the slicer about
 * exclusion zones and clearances, and the slicer is the one that gets the last word.
 */
export async function arrangePlate(
  printer: PresetRef,
  process: PresetRef,
  objects: ArrangeRequestBody['objects'],
): Promise<ArrangeResponse> {
  const response = await apiFetch('/plater/arrange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printer, process, objects } satisfies ArrangeRequestBody),
  });
  return (await response.json()) as ArrangeResponse;
}

/**
 * Upload the plate preview rendered from the WebGL view.
 *
 * SPEC: "the blank thumbnail is our problem to solve" — the slicer needs OpenGL to make
 * one and the container has no display server, so without this the printer's screen shows
 * an empty preview. VERIFIED DEVIATION #5: with `--min-save` the archive has no
 * `Metadata/plate_N.png` at all, so this adds one.
 */
export async function uploadPlateThumbnail(
  jobId: string,
  png: Blob,
  plate = 1,
): Promise<{ bytes: number }> {
  const response = await apiFetch(`/jobs/${jobId}/thumbnail?plate=${plate}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: png,
  });
  return (await response.json()) as { bytes: number };
}
