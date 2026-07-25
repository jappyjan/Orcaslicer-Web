/**
 * The server's view of M2's config schema: which options M6 may touch, and what shape
 * each of their values has.
 *
 * Two jobs, both of them boundary work:
 *
 *  1. **Deciding what is editable at all.** 751 options is the whole of what
 *     `PrintConfig.cpp` defines, and a few of them are not settings a web client has any
 *     business changing (see {@link RENDERABLE_REASONS}). The same predicate drives the
 *     UI and this validator, so the client cannot offer something the server would reject
 *     and the server cannot be talked into something the client never offers.
 *  2. **Coercing values to the declared shape.** JSON gives us `0.28` and `"0.28"` and
 *     `["0.28"]` interchangeably, and the engine's serialiser reads the *JS* type to pick
 *     a vector separator (SPEC deviation #25). So the wire value is coerced to what the
 *     schema says the option is before it reaches the engine, not after.
 *
 * Nothing here knows about OrcaSlicer's CLI; that stays behind the engine port.
 */

import type { ConfigOptionSchema, ConfigSchemaDocument } from '@orca-web/catalog';
import type { SettingOverrides, SettingValue } from '@orca-web/shared';

/** Why an option the schema defines is nonetheless not offered as a form field. */
export const RENDERABLE_REASONS = {
  develop: "upstream's hidden debug tier (`mode: develop`)",
  sla: 'an SLA/resin option; this application slices FFF only',
  readOnly: 'declared read-only upstream',
  unrenderable: 'has no generically renderable value shape (e.g. `coPointsGroups`)',
} as const;

export type NotRenderableReason = keyof typeof RENDERABLE_REASONS;

/** `PrintConfigDef` member the SLA options are defined in. There are 76 of them in 2.4.2. */
const SLA_SECTION = 'init_sla_params';

/**
 * Value shapes no form field can produce.
 *
 * `unknown` is what the extractor reports for `coPointsGroups`, which in 2.4.2 is exactly
 * `extruder_printable_area` — a per-extruder list of polygons. PROFILE-PIPELINE.md calls
 * it out by name as the one option that "cannot be rendered generically", and excluding
 * it explicitly beats discovering it as a crash.
 *
 * `point` / `points` are excluded for a different reason: they are bed geometry
 * (`printable_area`, `bed_exclude_area`), the plater draws itself from them, and a text
 * field that silently disagrees with the plate on screen is worse than no field at all.
 */
const UNRENDERABLE_KINDS = new Set(['unknown', 'point', 'points']);

/** Why {@link isRenderable} said no, or `null` when it said yes. */
export function notRenderableReason(option: ConfigOptionSchema): NotRenderableReason | null {
  if (option.mode === 'develop') return 'develop';
  if (option.section === SLA_SECTION) return 'sla';
  if (option.readOnly === true) return 'readOnly';
  if (UNRENDERABLE_KINDS.has(option.valueKind)) return 'unrenderable';
  return null;
}

export function isRenderable(option: ConfigOptionSchema): boolean {
  return notRenderableReason(option) === null;
}

export class UnknownSettingError extends Error {
  readonly key: string;
  readonly hint: string | undefined;
  constructor(key: string, message: string, hint?: string) {
    super(message);
    this.name = 'UnknownSettingError';
    this.key = key;
    this.hint = hint;
  }
}

/**
 * Coerce one wire value into the shape `option` declares.
 *
 * Returns `undefined` for a value that cannot be made to fit, so the caller decides
 * whether that is a 400 or a silently dropped key.
 */
export function coerceValue(option: ConfigOptionSchema, raw: unknown): SettingValue | undefined {
  if (raw === null || raw === 'nil') {
    // Only a nullable option has an "unset"; for anything else `null` is a client bug.
    return option.nullable ? null : undefined;
  }
  if (option.isArray) {
    const list = Array.isArray(raw) ? raw : [raw];
    const out: Array<string | number | boolean> = [];
    for (const element of list) {
      const scalar = coerceScalar(option, element);
      if (scalar === undefined) return undefined;
      out.push(scalar);
    }
    return out.length === 0 ? undefined : out;
  }
  // A one-element vector for a scalar option is a shape the UI can produce when a preset
  // stored the value as `["0.2"]`; unwrap rather than reject.
  const scalar = coerceScalar(option, Array.isArray(raw) ? raw[0] : raw);
  return scalar;
}

function coerceScalar(
  option: ConfigOptionSchema,
  raw: unknown,
): string | number | boolean | undefined {
  switch (option.valueKind) {
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 1 || raw === '1' || raw === 'true') return true;
      if (raw === 0 || raw === '0' || raw === 'false') return false;
      return undefined;
    case 'int':
    case 'float': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) return undefined;
      const rounded = option.valueKind === 'int' ? Math.round(value) : value;
      return withinBounds(option, rounded) ? rounded : undefined;
    }
    case 'percent':
    case 'floatOrPercent': {
      // `sparse_infill_density` is a percent and round-trips as `15%`; a bare number is
      // also accepted upstream, so both spellings survive.
      const text = String(raw).trim();
      if (text.endsWith('%')) {
        return Number.isFinite(Number(text.slice(0, -1))) ? text : undefined;
      }
      const value = Number(text);
      if (!Number.isFinite(value)) return undefined;
      return option.valueKind === 'percent' ? `${value}%` : value;
    }
    case 'enum': {
      const text = String(raw);
      const choices = option.enumChoices ?? [];
      return choices.some((choice) => choice.value === text) ? text : undefined;
    }
    case 'string':
      return typeof raw === 'string' ? raw : String(raw);
    default:
      return undefined;
  }
}

function withinBounds(option: ConfigOptionSchema, value: number): boolean {
  if (option.min !== undefined && value < option.min) return false;
  if (option.max !== undefined && value > option.max) return false;
  return true;
}

/**
 * Validate and coerce a whole override map.
 *
 * Throws {@link UnknownSettingError} rather than dropping anything: an override the
 * server quietly ignored would slice with the preset's value while the UI showed the
 * user's, which is the same class of silent-wrong-output failure as SPEC deviation #1.
 */
export function coerceOverrides(
  schema: ConfigSchemaDocument,
  raw: Readonly<Record<string, unknown>>,
): SettingOverrides {
  const out: SettingOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const option = schema.options[key];
    if (!option) {
      throw new UnknownSettingError(
        key,
        `"${key}" is not a setting this slicer version defines`,
        `OrcaSlicer ${schema.orcaVersion} defines ${Object.keys(schema.options).length} settings; check the spelling.`,
      );
    }
    const reason = notRenderableReason(option);
    if (reason !== null) {
      throw new UnknownSettingError(
        key,
        `"${key}" cannot be set from here: it is ${RENDERABLE_REASONS[reason]}`,
      );
    }
    const coerced = coerceValue(option, value);
    if (coerced === undefined) {
      throw new UnknownSettingError(
        key,
        `${JSON.stringify(value)} is not a valid value for "${key}"`,
        describeExpected(option),
      );
    }
    out[key] = coerced;
  }
  return out;
}

function describeExpected(option: ConfigOptionSchema): string {
  const shape = option.isArray ? `a list of ${option.valueKind}` : `a ${option.valueKind}`;
  const bounds =
    option.min === undefined && option.max === undefined
      ? ''
      : ` between ${option.min ?? '−∞'} and ${option.max ?? '∞'}`;
  const choices = option.enumChoices
    ? ` — one of ${option.enumChoices.map((c) => c.value).join(', ')}`
    : '';
  return `Expected ${shape}${bounds}${choices}.`;
}
