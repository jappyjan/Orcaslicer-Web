/**
 * Server-side validation of M6's overrides.
 *
 * Where the generated schema is available (a checkout that has run the extractors, and
 * every container build) the last block runs the same assertions against the REAL 2.4.2
 * definitions, so the counts and the excluded options are measured rather than asserted
 * from memory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  configSchemaPath,
  type ConfigOptionSchema,
  type ConfigSchemaDocument,
} from '@orca-web/catalog';
import {
  UnknownSettingError,
  coerceOverrides,
  coerceValue,
  isRenderable,
  notRenderableReason,
} from './schema.js';

function option(overrides: Partial<ConfigOptionSchema> & { key: string }): ConfigOptionSchema {
  return {
    type: 'coFloat',
    valueKind: 'float',
    isArray: false,
    nullable: false,
    mode: 'simple',
    default: 0,
    section: 'init_fff_params',
    sourceLine: 1,
    ...overrides,
  };
}

function schemaOf(...options: ConfigOptionSchema[]): ConfigSchemaDocument {
  return {
    orcaVersion: '2.4.2',
    sources: [],
    generatedAt: '',
    options: Object.fromEntries(options.map((entry) => [entry.key, entry])),
    cliOptions: {},
    placeholderOptions: {},
    categories: [],
    coverage: {
      definedInPrintConfigDef: 0,
      definedByOverrideLoop: 0,
      definedByAxisLoop: 0,
      redefinedKeys: 0,
      definedTotal: 0,
      extracted: 0,
      missing: 0,
      defaultsUnevaluated: 0,
      extractedNonPreset: 0,
    },
    gaps: [],
  };
}

describe('what the server will accept at all', () => {
  it('refuses the develop tier, SLA options and unrenderable shapes', () => {
    expect(notRenderableReason(option({ key: 'a', mode: 'develop' }))).toBe('develop');
    expect(notRenderableReason(option({ key: 'b', section: 'init_sla_params' }))).toBe('sla');
    expect(notRenderableReason(option({ key: 'c', valueKind: 'unknown' }))).toBe('unrenderable');
    expect(notRenderableReason(option({ key: 'd', readOnly: true }))).toBe('readOnly');
    expect(isRenderable(option({ key: 'e' }))).toBe(true);
  });
});

describe('coerceValue', () => {
  it('parses a float, an int and a percent', () => {
    expect(coerceValue(option({ key: 'a', valueKind: 'float' }), '0.28')).toBe(0.28);
    expect(coerceValue(option({ key: 'b', valueKind: 'int' }), '3.6')).toBe(4);
    expect(coerceValue(option({ key: 'c', valueKind: 'percent' }), 25)).toBe('25%');
    expect(coerceValue(option({ key: 'c', valueKind: 'percent' }), '25%')).toBe('25%');
  });

  it('enforces the schema bounds', () => {
    const bounded = option({ key: 'a', valueKind: 'float', min: 0, max: 1 });
    expect(coerceValue(bounded, 0.5)).toBe(0.5);
    expect(coerceValue(bounded, 2)).toBeUndefined();
    expect(coerceValue(bounded, -1)).toBeUndefined();
  });

  it('accepts only values the enum actually offers', () => {
    // MEASURED: `--seam-position rear` is rejected by the binary with `Invalid value for
    // option --seam-position` at exit 254. Catching it here turns that into a 400 with a
    // usable message instead of a failed slice.
    const seam = option({
      key: 'seam_position',
      valueKind: 'enum',
      enumChoices: [
        { value: 'aligned', label: 'Aligned' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(coerceValue(seam, 'back')).toBe('back');
    expect(coerceValue(seam, 'rear')).toBeUndefined();
  });

  it('reads every spelling of a boolean', () => {
    const flag = option({ key: 'a', type: 'coBool', valueKind: 'bool' });
    for (const truthy of [true, 1, '1', 'true']) expect(coerceValue(flag, truthy)).toBe(true);
    for (const falsy of [false, 0, '0', 'false']) expect(coerceValue(flag, falsy)).toBe(false);
    expect(coerceValue(flag, 'maybe')).toBeUndefined();
  });

  it('keeps a vector a vector, with typed elements', () => {
    // The element types are what the engine's serialiser reads to choose `,` over `;`
    // (SPEC deviation #27), so a numeric vector must not arrive as strings.
    const temps = option({ key: 'nozzle_temperature', valueKind: 'int', isArray: true });
    expect(coerceValue(temps, ['235', '240'])).toEqual([235, 240]);
    expect(coerceValue(temps, 235)).toEqual([235]);
  });

  it('unwraps a one-element vector for a scalar option', () => {
    // Presets store scalars this way often enough that rejecting it would be hostile.
    expect(coerceValue(option({ key: 'layer_height' }), ['0.2'])).toBe(0.2);
  });

  it('accepts "unset" only for a nullable option', () => {
    expect(coerceValue(option({ key: 'a', nullable: true, isArray: true }), null)).toBeNull();
    expect(coerceValue(option({ key: 'b' }), null)).toBeUndefined();
  });
});

describe('coerceOverrides', () => {
  const schema = schemaOf(
    option({ key: 'layer_height', min: 0.01, max: 1 }),
    option({ key: 'enable_support', type: 'coBool', valueKind: 'bool' }),
    option({ key: 'hidden_thing', mode: 'develop' }),
  );

  it('coerces every key it recognises', () => {
    expect(coerceOverrides(schema, { layer_height: '0.28', enable_support: '1' })).toEqual({
      layer_height: 0.28,
      enable_support: true,
    });
  });

  it('rejects rather than drops an unknown key', () => {
    // Dropping would slice with the preset's value while the UI went on showing the
    // user's — the same class of silent-wrong-output failure as deviation #1.
    expect(() => coerceOverrides(schema, { not_a_setting: 1 })).toThrow(UnknownSettingError);
  });

  it('rejects a key that exists but must not be set from here', () => {
    expect(() => coerceOverrides(schema, { hidden_thing: 1 })).toThrow(/develop/);
  });

  it('rejects an out-of-range value with a usable message', () => {
    expect(() => coerceOverrides(schema, { layer_height: 99 })).toThrow(/not a valid value/);
  });
});

// ---------------------------------------------------------------------------
// Against the real generated schema
// ---------------------------------------------------------------------------

/**
 * `/generated` is produced at image-build time, so this half only runs where it exists —
 * in the container and after `docker compose build`, not on a bare checkout.
 *
 * The file is read **here rather than inside the suite body**, and that is the whole
 * point of the shape. `describe.skip` still *evaluates* its callback to collect the tests
 * it is about to mark skipped, so a `readFileSync` in there throws on a bare checkout and
 * fails the file at collection time — which is what CI's "ENOENT: config-schema.json" was.
 * A `null` here skips quietly, as intended.
 */
const realPath = configSchemaPath('2.4.2');
const realSchema = existsSync(realPath)
  ? (JSON.parse(readFileSync(realPath, 'utf8')) as ConfigSchemaDocument)
  : null;
const describeReal = realSchema === null ? describe.skip : describe;

describeReal('the real OrcaSlicer 2.4.2 schema', () => {
  const schema = realSchema as ConfigSchemaDocument;
  const options = Object.values(schema?.options ?? {});

  it('defines 751 options, of which the develop tier is never offered', () => {
    expect(options).toHaveLength(751);
    expect(options.filter((o) => o.mode === 'develop')).toHaveLength(31);
    expect(options.filter((o) => notRenderableReason(o) === 'develop')).toHaveLength(31);
  });

  it('excludes extruder_printable_area by name', () => {
    const option = schema.options.extruder_printable_area as ConfigOptionSchema;
    expect(option.type).toBe('coPointsGroups');
    expect(notRenderableReason(option)).toBe('unrenderable');
  });

  it('offers the settings the acceptance test drives', () => {
    for (const key of [
      'layer_height',
      'sparse_infill_pattern',
      'enable_arc_fitting',
      'infill_combination',
      'nozzle_temperature',
    ]) {
      expect(isRenderable(schema.options[key] as ConfigOptionSchema)).toBe(true);
    }
  });

  it('coerces a real value of every widget family', () => {
    expect(coerceValue(schema.options.layer_height as ConfigOptionSchema, '0.28')).toBe(0.28);
    expect(coerceValue(schema.options.sparse_infill_pattern as ConfigOptionSchema, 'gyroid')).toBe(
      'gyroid',
    );
    expect(coerceValue(schema.options.enable_arc_fitting as ConfigOptionSchema, false)).toBe(false);
    expect(coerceValue(schema.options.nozzle_temperature as ConfigOptionSchema, 235)).toEqual([
      235,
    ]);
  });
});
