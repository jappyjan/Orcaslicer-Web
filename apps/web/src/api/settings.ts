/**
 * Fetching what the settings screen needs.
 *
 * Three rules, all of them about a phone:
 *
 *  1. **The schema is never on the main path.** `GET /catalog?schema=1` is 708 kB against
 *     `GET /catalog`'s 351 kB, and nothing before the settings sheet opens needs a single
 *     option definition. So it is fetched the first time the sheet is opened, once per
 *     session, and the browser's own cache (`max-age=3600`, strong ETag, static per
 *     OrcaSlicer version) handles the next visit.
 *  2. **The parsed schema is trimmed on arrival.** The wire document carries
 *     `cliOptions`, `placeholderOptions`, `coverage`, `gaps`, `sources` and per-option
 *     provenance the form has no use for. Keeping the whole thing alive for the life of
 *     the tab costs megabytes for nothing.
 *  3. **The resolved preset is re-fetched whenever the presets change**, because it is
 *     the baseline "modified" is measured against and a stale one would mislabel every
 *     field. It is small — a few hundred keys — so this is cheap.
 */

import type {
  PresetRef,
  ResolvedSettings,
  UserPreset,
  UserPresetListResponse,
} from '@orca-web/shared';
import { apiFetch, getJson } from './http.ts';
import type { ConfigSchema, OptionSchema } from '../state/settings.ts';

interface WireSchemaDocument {
  orcaVersion: string;
  options: Record<string, OptionSchema>;
  categories: string[];
}

interface WireCatalogWithSchema {
  configSchema?: WireSchemaDocument;
}

/**
 * The fields the form reads, and nothing else — see rule 2. Written as an explicit pick
 * rather than a spread so that a schema gaining a field does not silently grow the
 * client's heap.
 */
function trimOption(option: OptionSchema): OptionSchema {
  const trimmed: OptionSchema = {
    key: option.key,
    type: option.type,
    valueKind: option.valueKind,
    isArray: option.isArray,
    nullable: option.nullable,
    mode: option.mode,
    default: option.default,
    section: option.section,
  };
  if (option.label !== undefined) trimmed.label = option.label;
  if (option.fullLabel !== undefined) trimmed.fullLabel = option.fullLabel;
  if (option.tooltip !== undefined) trimmed.tooltip = option.tooltip;
  if (option.category !== undefined) trimmed.category = option.category;
  if (option.units !== undefined) trimmed.units = option.units;
  if (option.min !== undefined) trimmed.min = option.min;
  if (option.max !== undefined) trimmed.max = option.max;
  if (option.enumChoices !== undefined) trimmed.enumChoices = option.enumChoices;
  if (option.multiline !== undefined) trimmed.multiline = option.multiline;
  if (option.readOnly !== undefined) trimmed.readOnly = option.readOnly;
  if (option.derivedFrom !== undefined) trimmed.derivedFrom = option.derivedFrom;
  return trimmed;
}

export function buildSchema(wire: WireSchemaDocument): ConfigSchema {
  const options: Record<string, OptionSchema> = {};
  for (const [key, option] of Object.entries(wire.options)) options[key] = trimOption(option);
  return { orcaVersion: wire.orcaVersion, options, categories: wire.categories };
}

let schemaPromise: Promise<ConfigSchema> | undefined;

/** Loaded lazily, once per session. Do not call this before the user asks for settings. */
export function loadConfigSchema(): Promise<ConfigSchema> {
  schemaPromise ??= getJson<WireCatalogWithSchema>('/catalog?schema=1')
    .then((body) => {
      if (!body.configSchema) throw new Error('the catalog response carried no config schema');
      return buildSchema(body.configSchema);
    })
    .catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });
  return schemaPromise;
}

/** Test seam. */
export function resetSchemaCache(): void {
  schemaPromise = undefined;
}

/**
 * The values a slice would use before any override — the baseline `modified` is measured
 * against, and deliberately not the compiled-in defaults (SPEC deviation #1).
 */
export function loadResolvedSettings(presets: {
  machine: PresetRef;
  process: PresetRef;
  filament: PresetRef;
}): Promise<ResolvedSettings> {
  const query = new URLSearchParams({
    machineVendor: presets.machine.vendor,
    machineName: presets.machine.name,
    processVendor: presets.process.vendor,
    processName: presets.process.name,
    filamentVendor: presets.filament.vendor,
    filamentName: presets.filament.name,
  });
  return getJson<ResolvedSettings>(`/settings/resolved?${query.toString()}`);
}

// ---------------------------------------------------------------------------
// Named user presets — ours, stored server-side, never OrcaSlicer profile files
// ---------------------------------------------------------------------------

export function loadUserPresets(): Promise<UserPreset[]> {
  return getJson<UserPresetListResponse>('/settings/presets').then((body) => body.presets);
}

export function saveUserPreset(input: {
  id?: string;
  name: string;
  overrides: Record<string, unknown>;
  basedOn: UserPreset['basedOn'];
}): Promise<UserPreset> {
  const { id, ...body } = input;
  return apiFetch(id === undefined ? '/settings/presets' : `/settings/presets/${id}`, {
    method: id === undefined ? 'POST' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => response.json() as Promise<UserPreset>);
}

export async function deleteUserPreset(id: string): Promise<void> {
  await apiFetch(`/settings/presets/${id}`, { method: 'DELETE' });
}
