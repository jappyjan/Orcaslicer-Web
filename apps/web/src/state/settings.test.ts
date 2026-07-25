/**
 * The settings model, and above all what "modified" means.
 *
 * The load-bearing test in this file is the one that proves the diff is taken against the
 * **resolved preset** and not against `ConfigOptionSchema.default`. Those two differ for
 * almost every interesting key — the compiled-in `layer_height` default is 0.2 and a
 * 0.08 mm preset sets 0.08 — and confusing them is SPEC deviation #1's exact failure
 * mode: the CLI silently falls back to the default for any key a preset does not mention,
 * so a UI that diffed against the default would report the wrong thing in both
 * directions.
 */

import { describe, expect, it } from 'vitest';
import type { SettingSource, SettingValue } from '@orca-web/shared';
import {
  NO_OVERRIDES,
  asList,
  baseValue,
  buildIndex,
  clearOverride,
  effectiveValue,
  groupOf,
  isEditable,
  isModified,
  isVisibleAtMode,
  labelOf,
  modifiedCount,
  orderGroups,
  reconcile,
  sameValue,
  searchOptions,
  setOverride,
  type ConfigSchema,
  type OptionSchema,
} from './settings.ts';

function option(overrides: Partial<OptionSchema> & { key: string }): OptionSchema {
  return {
    type: 'coFloat',
    valueKind: 'float',
    isArray: false,
    nullable: false,
    mode: 'simple',
    default: 0,
    section: 'init_fff_params',
    ...overrides,
  };
}

const LAYER_HEIGHT = option({
  key: 'layer_height',
  label: 'Layer height',
  category: 'Quality',
  units: 'mm',
  // The compiled-in PrintConfig default, which is NOT the preset's value.
  default: 0.2,
});

const NOZZLE_TEMPERATURE = option({
  key: 'nozzle_temperature',
  label: 'Nozzle temperature',
  type: 'coInts',
  valueKind: 'int',
  isArray: true,
  units: '℃',
  default: [200],
});

const ARC_FITTING = option({
  key: 'enable_arc_fitting',
  label: 'Arc fitting',
  type: 'coBool',
  valueKind: 'bool',
  category: 'Quality',
  mode: 'advanced',
  default: false,
});

function resolved(
  values: Record<string, SettingValue>,
  sources: Record<string, SettingSource> = {},
) {
  return { values, sources };
}

describe('baseValue — the preset, not the compiled-in default', () => {
  it('reports the preset value when the preset sets the key', () => {
    const base = baseValue(
      'layer_height',
      LAYER_HEIGHT,
      resolved({ layer_height: '0.08' }, { layer_height: 'process' }),
    );
    expect(base).toEqual({ value: '0.08', origin: 'preset', source: 'process' });
    // The compiled-in default is 0.2 and is deliberately not what came back.
    expect(base.value).not.toBe(LAYER_HEIGHT.default);
  });

  it('falls back to the compiled-in default only when NO preset mentions the key, and says so', () => {
    // This is the deviation #1 case: the CLI would use 0.2 here, silently, and the UI has
    // to be able to say that the number on screen is not something a preset chose.
    const base = baseValue('layer_height', LAYER_HEIGHT, resolved({ wall_loops: '3' }));
    expect(base).toEqual({ value: 0.2, origin: 'default', source: null });
  });

  it('treats a key present with a falsy value as set by the preset', () => {
    const base = baseValue(
      'enable_arc_fitting',
      ARC_FITTING,
      resolved({ enable_arc_fitting: '0' }, { enable_arc_fitting: 'process' }),
    );
    expect(base.origin).toBe('preset');
  });

  it('falls back to the default when there is no resolved preset at all', () => {
    expect(baseValue('layer_height', LAYER_HEIGHT, null).origin).toBe('default');
  });
});

describe('sameValue', () => {
  it('sees through the string/number and scalar/vector spellings presets use', () => {
    expect(sameValue('0.2', 0.2)).toBe(true);
    expect(sameValue(['220'], 220)).toBe(true);
    expect(sameValue(['220', '220'], [220, 220])).toBe(true);
    expect(sameValue('1', true)).toBe(true);
    expect(sameValue('0', false)).toBe(true);
  });

  it('still distinguishes different values', () => {
    expect(sameValue('0.2', 0.28)).toBe(false);
    expect(sameValue(['220', '220'], [220])).toBe(false);
    expect(sameValue('aligned', 'back')).toBe(false);
    expect(sameValue(null, 0)).toBe(false);
  });
});

describe('the override set', () => {
  const base: SettingValue = '0.2';

  it('records a value that differs from the preset', () => {
    const state = setOverride(NO_OVERRIDES, 'layer_height', 0.28, base);
    expect(state.overrides).toEqual({ layer_height: 0.28 });
    expect(isModified(state, 'layer_height')).toBe(true);
  });

  it('records nothing when the value matches the preset, however it is spelled', () => {
    // Typing the preset's own number back in must leave no flag on the command line:
    // otherwise "revert" and "retype the old value" would be two different job states
    // that slice identically.
    expect(setOverride(NO_OVERRIDES, 'layer_height', 0.2, base).overrides).toEqual({});
    expect(setOverride(NO_OVERRIDES, 'layer_height', '0.2', base).overrides).toEqual({});
  });

  it('clears an existing override when the value returns to the preset', () => {
    const changed = setOverride(NO_OVERRIDES, 'layer_height', 0.28, base);
    expect(modifiedCount(setOverride(changed, 'layer_height', 0.2, base))).toBe(0);
  });

  it('reverts one key without touching the others', () => {
    let state = setOverride(NO_OVERRIDES, 'layer_height', 0.28, '0.2');
    state = setOverride(state, 'wall_loops', 4, '2');
    expect(clearOverride(state, 'layer_height').overrides).toEqual({ wall_loops: 4 });
  });

  it('shows the override, and the base when there is none', () => {
    const presetBase = baseValue('layer_height', LAYER_HEIGHT, resolved({ layer_height: '0.08' }));
    expect(effectiveValue(NO_OVERRIDES, 'layer_height', presetBase)).toBe('0.08');
    const state = setOverride(NO_OVERRIDES, 'layer_height', 0.28, presetBase.value);
    expect(effectiveValue(state, 'layer_height', presetBase)).toBe(0.28);
  });
});

describe('reconcile — changing the preset changes the baseline', () => {
  const schema: ConfigSchema = {
    orcaVersion: '2.4.2',
    options: { layer_height: LAYER_HEIGHT, wall_loops: option({ key: 'wall_loops', default: 2 }) },
    categories: ['Quality'],
  };

  it('drops an override that the new preset now agrees with', () => {
    const state = { overrides: { layer_height: 0.28, wall_loops: 4 } };
    const next = reconcile(state, schema, resolved({ layer_height: '0.28', wall_loops: '2' }));
    expect(next.overrides).toEqual({ wall_loops: 4 });
  });

  it('drops a key this OrcaSlicer version no longer defines', () => {
    const state = { overrides: { layer_height: 0.28, gone_away: 1 } };
    expect(reconcile(state, schema, resolved({})).overrides).toEqual({ layer_height: 0.28 });
  });

  it('is a no-op with nothing to compare against', () => {
    const state = { overrides: { layer_height: 0.28 } };
    expect(reconcile(state, schema, null)).toBe(state);
  });
});

describe('what is offered at all', () => {
  it('never renders the develop tier, at any disclosure level', () => {
    expect(isEditable(option({ key: 'x', mode: 'develop' }))).toBe(false);
  });

  it('hides SLA options — this application slices FFF', () => {
    expect(isEditable(option({ key: 'x', section: 'init_sla_params' }))).toBe(false);
  });

  it('excludes the one option with no renderable shape', () => {
    // `extruder_printable_area` is coPointsGroups; PROFILE-PIPELINE.md names it as the
    // option that cannot be rendered generically.
    expect(
      isEditable(
        option({ key: 'extruder_printable_area', type: 'coPointsGroups', valueKind: 'unknown' }),
      ),
    ).toBe(false);
  });

  it('reveals simple ⊂ advanced ⊂ expert', () => {
    const simple = option({ key: 'a', mode: 'simple' });
    const advanced = option({ key: 'b', mode: 'advanced' });
    const expert = option({ key: 'c', mode: 'expert' });
    expect([simple, advanced, expert].map((o) => isVisibleAtMode(o, 'simple'))).toEqual([
      true,
      false,
      false,
    ]);
    expect([simple, advanced, expert].map((o) => isVisibleAtMode(o, 'advanced'))).toEqual([
      true,
      true,
      false,
    ]);
    expect([simple, advanced, expert].map((o) => isVisibleAtMode(o, 'expert'))).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe('grouping', () => {
  it("uses upstream's own category when there is one", () => {
    expect(groupOf(LAYER_HEIGHT, 'process')).toBe('Quality');
  });

  it('files an uncategorised option under the preset that supplies it', () => {
    expect(groupOf(NOZZLE_TEMPERATURE, 'filament')).toBe('Filament');
    expect(groupOf(option({ key: 'auxiliary_fan' }), 'machine')).toBe('Printer');
  });

  it('falls back to the key prefix, then to Other', () => {
    expect(groupOf(option({ key: 'filament_soluble' }), undefined)).toBe('Filament');
    expect(groupOf(option({ key: 'machine_max_jerk_x' }), undefined)).toBe('Printer');
    expect(groupOf(option({ key: 'nonsense' }), undefined)).toBe('Other');
  });

  it("orders upstream's categories first, in the schema's order", () => {
    expect(
      orderGroups(['Filament', 'Support', 'Quality', 'Other'], ['Quality', 'Support']),
    ).toEqual(['Quality', 'Support', 'Filament', 'Other']);
  });
});

describe('search', () => {
  const schema: ConfigSchema = {
    orcaVersion: '2.4.2',
    options: {
      layer_height: LAYER_HEIGHT,
      nozzle_temperature: NOZZLE_TEMPERATURE,
      enable_arc_fitting: ARC_FITTING,
    },
    categories: ['Quality'],
  };
  const index = buildIndex(schema, { nozzle_temperature: 'filament' });

  it('matches every term, in any order', () => {
    expect(searchOptions(index, 'height layer', 'expert').map((e) => e.option.key)).toEqual([
      'layer_height',
    ]);
  });

  it('finds an option by its raw config key', () => {
    // Which is why the key is printed under every field.
    expect(searchOptions(index, 'nozzle_temperature', 'expert')).toHaveLength(1);
  });

  it('respects the disclosure level', () => {
    expect(searchOptions(index, 'arc', 'simple')).toHaveLength(0);
    expect(searchOptions(index, 'arc', 'advanced')).toHaveLength(1);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchOptions(index, '   ', 'expert')).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('falls back to the key when upstream gave no label', () => {
    expect(labelOf(option({ key: 'mystery_key' }))).toBe('mystery_key');
    expect(labelOf(LAYER_HEIGHT)).toBe('Layer height');
  });

  it('normalises a value into a list of elements', () => {
    expect(asList(['220', '220'])).toEqual(['220', '220']);
    expect(asList(0.2)).toEqual([0.2]);
    expect(asList(null)).toEqual([]);
  });
});
