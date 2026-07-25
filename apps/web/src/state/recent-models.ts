/**
 * The client's memory of the server's content-addressed model library.
 *
 * The API has no "list my models" endpoint — the library is keyed by content hash, not
 * by user — so the client keeps its own short list of `sha256:` ids it has uploaded. That
 * is all it takes to make "slice this again with a different filament" cost zero bytes
 * of upload, which is the whole reason the library exists (docs/SPEC.md, "Model storage").
 *
 * Entries can go stale: the server sweeps by LRU and TTL, so an id here may 404 on
 * submit. That surfaces as the API's own `INPUT_NOT_FOUND` message, and re-uploading the
 * file fixes it — which is why the list is a convenience, never a source of truth.
 */

import type { ModelSummary } from '@orca-web/shared';

const STORAGE_KEY = 'orca-web.models.v1';
const LIMIT = 12;

export function readRecentModels(storage: Storage | undefined): ModelSummary[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ModelSummary =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ModelSummary).id === 'string' &&
        typeof (entry as ModelSummary).filename === 'string',
    );
  } catch {
    return [];
  }
}

/** Most recent first, de-duplicated by content id. */
export function rememberModel(
  models: readonly ModelSummary[],
  model: ModelSummary,
): ModelSummary[] {
  return [model, ...models.filter((candidate) => candidate.id !== model.id)].slice(0, LIMIT);
}

export function saveRecentModels(
  models: readonly ModelSummary[],
  storage: Storage | undefined,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(models));
  } catch {
    // Storage unavailable; the list is a convenience.
  }
}
