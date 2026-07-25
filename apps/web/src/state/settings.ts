/**
 * The settings model: 751 options, what they are worth right now, and which of them the
 * user has changed.
 *
 * ## What "modified" means, and what it does not
 *
 * A value is modified when the user has set it **and it differs from the value the slice
 * would otherwise use**. That baseline is the *resolved preset*, fetched from
 * `GET /settings/resolved` — machine ⊕ process ⊕ filament, fully flattened.
 *
 * It is emphatically **not** `ConfigOptionSchema.default`. The two are different things
 * and treating them as one is SPEC deviation #1's exact failure mode: `default` is the
 * compiled-in `PrintConfig` value the CLI silently falls back to for any key a preset
 * does not mention, so a UI that diffed against it would report "unmodified" for a value
 * the slice is about to change, and vice versa. {@link baseValue} therefore answers with
 * *where the number came from* as well as what it is, and the two cases read differently
 * on screen.
 *
 * ## What gets sent
 *
 * Only the modified keys, as `JobRequest.overrides`. That is diff-and-override: the
 * highest-priority layer of the settings stack is the command line, so one flag changes
 * one key and nothing else — no profile file is written, and nothing about the preset
 * the user picked is disturbed.
 */

import type { SettingOverrides, SettingSource, SettingValue } from '@orca-web/shared';

// The schema shapes, re-declared rather than imported from `@orca-web/catalog`: that
// package reads files from disk and docs/REPO-LAYOUT.md keeps it out of the client.

export type DisclosureMode = 'simple' | 'advanced' | 'expert' | 'develop';

export type ValueKind =
  | 'float'
  | 'int'
  | 'string'
  | 'bool'
  | 'percent'
  | 'floatOrPercent'
  | 'point'
  | 'points'
  | 'enum'
  | 'unknown';

export interface EnumChoice {
  value: string;
  label: string;
}

export interface OptionSchema {
  key: string;
  type: string;
  valueKind: ValueKind;
  isArray: boolean;
  nullable: boolean;
  label?: string;
  fullLabel?: string;
  tooltip?: string;
  category?: string;
  units?: string;
  min?: number;
  max?: number;
  mode: DisclosureMode;
  enumChoices?: EnumChoice[];
  default: unknown;
  multiline?: boolean;
  readOnly?: boolean;
  derivedFrom?: string;
  section: string;
}

export interface ConfigSchema {
  orcaVersion: string;
  options: Record<string, OptionSchema>;
  categories: string[];
}

// ---------------------------------------------------------------------------
// What is shown at all
// ---------------------------------------------------------------------------

/** `PrintConfigDef` member the 76 SLA/resin options come from. This application is FFF. */
const SLA_SECTION = 'init_sla_params';

/**
 * Value shapes no generic form field can produce.
 *
 * `unknown` is the extractor's report for `coPointsGroups`, which in 2.4.2 is exactly
 * `extruder_printable_area`; PROFILE-PIPELINE.md names it as the one option that cannot
 * be rendered generically, and excluding it deliberately beats crashing on it.
 * `point`/`points` are bed geometry the plater draws itself from — a text field that
 * quietly disagreed with the plate on screen would be worse than no field.
 *
 * These must stay in step with `apps/api/src/settings/schema.ts`, which enforces the same
 * predicate server-side; a field the client offered and the server refused would be a
 * 400 the user cannot act on.
 */
const UNRENDERABLE_KINDS = new Set<ValueKind>(['unknown', 'point', 'points']);

export function isEditable(option: OptionSchema): boolean {
  // `develop` is upstream's hidden/debug tier and is never rendered, at any disclosure
  // level — that is what the level *means* upstream, not a policy we invented.
  if (option.mode === 'develop') return false;
  if (option.section === SLA_SECTION) return false;
  if (option.readOnly === true) return false;
  return !UNRENDERABLE_KINDS.has(option.valueKind);
}

/** `simple ⊂ advanced ⊂ expert`, exactly as `ConfigOptionMode` orders them upstream. */
const MODE_RANK: Record<DisclosureMode, number> = {
  simple: 0,
  advanced: 1,
  expert: 2,
  develop: 3,
};

export type VisibleMode = 'simple' | 'advanced' | 'expert';

export function isVisibleAtMode(option: OptionSchema, mode: VisibleMode): boolean {
  return MODE_RANK[option.mode] <= MODE_RANK[mode];
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Where an option is filed.
 *
 * Upstream's own `category` is used wherever there is one — those 312 options carry the
 * grouping OrcaSlicer's own settings pages use, and inventing a different one would only
 * make the two harder to talk about.
 *
 * The other options have no `category` because upstream's *print* settings pages are the
 * only ones built from it; filament and printer settings live in different tabs and are
 * grouped by hand in C++. Hiding them would leave 58 % of the schema uneditable and the
 * milestone's own acceptance criterion unmet, so they are filed by **which preset supplies
 * the value** — real information, read off `GET /settings/resolved`, not a guess. A key no
 * preset mentions falls back to a name-prefix rule and finally to "Other".
 */
export function groupOf(option: OptionSchema, source: SettingSource | undefined): string {
  if (option.category !== undefined && option.category !== '') return option.category;
  if (source === 'filament') return 'Filament';
  if (source === 'machine') return 'Printer';
  if (source === 'process') return 'Process';
  if (option.key.startsWith('filament_')) return 'Filament';
  if (
    option.key.startsWith('machine_') ||
    option.key.startsWith('printer_') ||
    option.key.startsWith('printhost_') ||
    option.key.startsWith('bed_') ||
    option.key.startsWith('extruder_')
  ) {
    return 'Printer';
  }
  return 'Other';
}

/** Upstream's own categories first, in the schema's order; our derived groups after. */
export function orderGroups(groups: readonly string[], categories: readonly string[]): string[] {
  const rank = new Map(categories.map((name, index) => [name, index]));
  return [...groups].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra === rb ? a.localeCompare(b) : ra - rb;
  });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Where the value a slice would use comes from, when no override is in play. */
export type ValueOrigin = 'preset' | 'default';

export interface BaseValue {
  value: SettingValue;
  origin: ValueOrigin;
  /** Which preset supplied it. Only meaningful when `origin === 'preset'`. */
  source: SettingSource | null;
}

/**
 * The value this slice would use for `key` if the user changed nothing.
 *
 * The distinction between the two origins is the whole point of this function: a preset
 * value is something the user chose (via the preset), a default is something the CLI
 * would fall back to *because no preset mentions the key at all*. The UI says those two
 * things differently, and only the first is a meaningful thing to be "modified from".
 */
export function baseValue(
  key: string,
  option: OptionSchema,
  resolved: { values: Record<string, SettingValue>; sources: Record<string, SettingSource> } | null,
): BaseValue {
  const fromPreset = resolved?.values[key];
  if (resolved && Object.prototype.hasOwnProperty.call(resolved.values, key)) {
    return { value: fromPreset ?? null, origin: 'preset', source: resolved.sources[key] ?? null };
  }
  return { value: (option.default ?? null) as SettingValue, origin: 'default', source: null };
}

/**
 * Are two setting values the same slice?
 *
 * Deliberately loose about representation and strict about meaning. Presets store
 * everything as strings and often as one-element arrays (`layer_height: "0.2"`,
 * `nozzle_temperature: ["220","220"]`), while a form field produces a number. Comparing
 * those with `===` would mark every field the user merely *looked at* as modified, and
 * then send an override that changes nothing — noise in the command line, and a "12
 * modified" badge that means nothing.
 */
export function sameValue(a: SettingValue, b: SettingValue): boolean {
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    if (left.length !== right.length) return false;
    return left.every((element, index) => sameScalar(element, right[index] as SettingValue));
  }
  return sameScalar(a, b);
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return asBool(a) === asBool(b);
  }
  const na = Number(a);
  const nb = Number(b);
  if (
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    String(a).trim() !== '' &&
    String(b).trim() !== ''
  ) {
    return na === nb;
  }
  return String(a) === String(b);
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** Every element of a vector value, as a list, whatever shape it arrived in. */
export function asList(value: SettingValue): Array<string | number | boolean> {
  if (value === null) return [];
  if (Array.isArray(value)) return [...value] as Array<string | number | boolean>;
  return [value as string | number | boolean];
}

// ---------------------------------------------------------------------------
// The override set
// ---------------------------------------------------------------------------

export interface SettingsState {
  /** Only keys that differ from {@link BaseValue}; see {@link setOverride}. */
  overrides: SettingOverrides;
}

export const NO_OVERRIDES: SettingsState = { overrides: {} };

/**
 * Set one key, or clear it when the new value matches the base.
 *
 * Clearing on a match is what keeps "modified" honest: typing 0.2 back into a field whose
 * preset value is 0.2 leaves nothing behind, so the command line stays empty and the
 * badge goes back to zero. Without it, "revert" and "type the old number" would leave the
 * job in two different states that slice identically.
 */
export function setOverride(
  state: SettingsState,
  key: string,
  value: SettingValue,
  base: SettingValue,
): SettingsState {
  if (sameValue(value, base)) return clearOverride(state, key);
  return { overrides: { ...state.overrides, [key]: value } };
}

export function clearOverride(state: SettingsState, key: string): SettingsState {
  if (!(key in state.overrides)) return state;
  const overrides = { ...state.overrides };
  delete overrides[key];
  return { overrides };
}

export function clearAll(): SettingsState {
  return NO_OVERRIDES;
}

export function modifiedCount(state: SettingsState): number {
  return Object.keys(state.overrides).length;
}

export function isModified(state: SettingsState, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.overrides, key);
}

/** What a field shows: the override if there is one, otherwise the base. */
export function effectiveValue(state: SettingsState, key: string, base: BaseValue): SettingValue {
  return isModified(state, key) ? (state.overrides[key] as SettingValue) : base.value;
}

/**
 * Drop overrides that no longer differ from the base.
 *
 * Changing the printer or the filament changes the baseline underneath a set of
 * overrides. One that now matches its new preset is not a modification any more, and
 * sending it would put a redundant flag on the command line.
 */
export function reconcile(
  state: SettingsState,
  schema: ConfigSchema | null,
  resolved: { values: Record<string, SettingValue>; sources: Record<string, SettingSource> } | null,
): SettingsState {
  if (!schema || !resolved) return state;
  let changed = false;
  const overrides: SettingOverrides = {};
  for (const [key, value] of Object.entries(state.overrides)) {
    const option = schema.options[key];
    if (!option) {
      changed = true;
      continue;
    }
    if (sameValue(value, baseValue(key, option, resolved).value)) {
      changed = true;
      continue;
    }
    overrides[key] = value;
  }
  return changed ? { overrides } : state;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchableOption {
  option: OptionSchema;
  group: string;
  /** Pre-lowercased `label + key + tooltip + group`, so a keystroke costs one scan. */
  haystack: string;
}

export function buildIndex(
  schema: ConfigSchema,
  sources: Record<string, SettingSource>,
): SearchableOption[] {
  const index: SearchableOption[] = [];
  for (const option of Object.values(schema.options)) {
    if (!isEditable(option)) continue;
    const group = groupOf(option, sources[option.key]);
    index.push({
      option,
      group,
      haystack:
        `${option.label ?? ''} ${option.fullLabel ?? ''} ${option.key} ${group} ${option.tooltip ?? ''}`.toLowerCase(),
    });
  }
  return index.sort((a, b) => labelOf(a.option).localeCompare(labelOf(b.option)));
}

export function labelOf(option: OptionSchema): string {
  const label = option.fullLabel ?? option.label;
  return label === undefined || label === '' ? option.key : label;
}

/** Every term must match, in any order — "infill pattern" finds "Sparse infill pattern". */
export function searchOptions(
  index: readonly SearchableOption[],
  query: string,
  mode: VisibleMode,
): SearchableOption[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return index.filter(
    (entry) =>
      isVisibleAtMode(entry.option, mode) && terms.every((term) => entry.haystack.includes(term)),
  );
}
