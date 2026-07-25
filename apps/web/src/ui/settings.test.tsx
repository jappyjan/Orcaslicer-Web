/**
 * Component tests for the settings sheet.
 *
 * jsdom says nothing about pixels — the 390 px layout and the 44 px targets are measured
 * for real in the Chromium pass (`test/e2e/settings.mjs`). What is checked here is the
 * behaviour that makes 751 options navigable at all, and that the "modified" marking is
 * driven by the preset rather than by the compiled-in default.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedSettings } from '@orca-web/shared';
import { NO_OVERRIDES, type ConfigSchema, type OptionSchema } from '../state/settings.ts';
import { SettingsScreen } from './SettingsScreen.tsx';

afterEach(() => {
  document.body.innerHTML = '';
});

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

const SCHEMA: ConfigSchema = {
  orcaVersion: '2.4.2',
  categories: ['Quality', 'Strength', 'Support'],
  options: {
    layer_height: option({
      key: 'layer_height',
      label: 'Layer height',
      category: 'Quality',
      units: 'mm',
      default: 0.2,
    }),
    seam_position: option({
      key: 'seam_position',
      label: 'Seam position',
      category: 'Quality',
      valueKind: 'enum',
      type: 'coEnum',
      default: 'aligned',
      enumChoices: [
        { value: 'nearest', label: 'Nearest' },
        { value: 'aligned', label: 'Aligned' },
        { value: 'back', label: 'Back' },
      ],
    }),
    enable_support: option({
      key: 'enable_support',
      label: 'Enable support',
      category: 'Support',
      type: 'coBool',
      valueKind: 'bool',
      default: false,
    }),
    nozzle_temperature: option({
      key: 'nozzle_temperature',
      label: 'Nozzle temperature',
      type: 'coInts',
      valueKind: 'int',
      isArray: true,
      units: '℃',
      default: [200],
    }),
    hidden_debug: option({ key: 'hidden_debug', label: 'Debug thing', mode: 'develop' }),
    resin_thing: option({ key: 'resin_thing', label: 'Resin', section: 'init_sla_params' }),
    extruder_printable_area: option({
      key: 'extruder_printable_area',
      label: 'Per-extruder area',
      type: 'coPointsGroups',
      valueKind: 'unknown',
    }),
    wall_loops: option({
      key: 'wall_loops',
      label: 'Wall loops',
      category: 'Strength',
      valueKind: 'int',
      mode: 'advanced',
      default: 2,
    }),
  },
};

const RESOLVED: ResolvedSettings = {
  values: {
    // Deliberately not the compiled-in defaults: this is the preset speaking.
    layer_height: '0.08',
    seam_position: 'aligned',
    enable_support: '0',
    nozzle_temperature: ['220', '220'],
  },
  sources: {
    layer_height: 'process',
    seam_position: 'process',
    enable_support: 'process',
    nozzle_temperature: 'filament',
  },
  presets: {
    machine: { kind: 'machine', vendor: 'BBL', name: 'X1C 0.4 nozzle' },
    process: { kind: 'process', vendor: 'BBL', name: '0.08mm Fine' },
    filament: { kind: 'filament', vendor: 'BBL', name: 'PLA' },
  },
};

function renderSheet(overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <SettingsScreen
      schema={SCHEMA}
      resolved={RESOLVED}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      state={NO_OVERRIDES}
      onChange={onChange}
      onClose={vi.fn()}
      userPresets={[]}
      presetContext={null}
      onSavePreset={vi.fn()}
      onDeletePreset={vi.fn()}
      presetError={null}
      {...overrides}
    />,
  );
  return { onChange };
}

describe('the settings sheet', () => {
  it('opens on groups, not on a list of every option', () => {
    renderSheet();
    expect(screen.getByTestId('settings-group-Quality')).toBeTruthy();
    // Nothing is rendered as a field until a group is opened or a search is typed.
    expect(screen.queryByTestId('setting-layer_height')).toBeNull();
  });

  it('never offers the develop tier, SLA options or the unrenderable one', () => {
    renderSheet();
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'e' } });
    for (const key of ['hidden_debug', 'resin_thing', 'extruder_printable_area']) {
      expect(screen.queryByTestId(`setting-${key}`)).toBeNull();
    }
  });

  it('reveals more as the disclosure level rises', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('mode-simple'));
    expect(screen.queryByTestId('settings-group-Strength')).toBeNull();
    fireEvent.click(screen.getByTestId('mode-advanced'));
    expect(screen.getByTestId('settings-group-Strength')).toBeTruthy();
  });

  it('finds a setting by its raw config key', () => {
    renderSheet();
    fireEvent.change(screen.getByTestId('settings-search'), {
      target: { value: 'nozzle_temperature' },
    });
    expect(screen.getByTestId('setting-nozzle_temperature')).toBeTruthy();
  });

  it('shows the preset value, and says which preset it came from', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('settings-group-Quality'));
    const field = screen.getByTestId('field-layer_height') as HTMLInputElement;
    // 0.08 from the preset — NOT the compiled-in default of 0.2.
    expect(field.value).toBe('0.08');
    expect(screen.getByTestId('setting-layer_height').textContent).toContain('process preset');
  });

  it('says out loud when a value comes from no preset at all', () => {
    // No preset in the chain sets `wall_loops`, so the number on screen is the CLI's
    // compiled-in fallback and the row has to say so — deviation #1 in one sentence.
    renderSheet();
    fireEvent.click(screen.getByTestId('mode-advanced'));
    fireEvent.click(screen.getByTestId('settings-group-Strength'));
    expect(screen.getByTestId('setting-wall_loops').textContent).toContain('slicer built-in');
  });

  it('records a change as an override against the preset value', () => {
    const { onChange } = renderSheet();
    fireEvent.click(screen.getByTestId('settings-group-Quality'));
    fireEvent.change(screen.getByTestId('field-layer_height'), { target: { value: '0.28' } });
    expect(onChange).toHaveBeenCalledWith({ overrides: { layer_height: 0.28 } });
  });

  it('records nothing when the value is typed back to the preset value', () => {
    const { onChange } = renderSheet({ state: { overrides: { layer_height: 0.28 } } });
    fireEvent.click(screen.getByTestId('settings-group-Quality'));
    fireEvent.change(screen.getByTestId('field-layer_height'), { target: { value: '0.08' } });
    expect(onChange).toHaveBeenCalledWith({ overrides: {} });
  });

  it('submits the enum value while rendering upstream label and order', () => {
    const { onChange } = renderSheet();
    fireEvent.click(screen.getByTestId('settings-group-Quality'));
    const select = screen.getByTestId('field-seam_position') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Nearest', 'Aligned', 'Back']);
    fireEvent.change(select, { target: { value: 'back' } });
    expect(onChange).toHaveBeenCalledWith({ overrides: { seam_position: 'back' } });
  });

  it('turns a boolean on and off as a real boolean', () => {
    const { onChange } = renderSheet();
    fireEvent.click(screen.getByTestId('settings-group-Support'));
    fireEvent.click(screen.getByTestId('field-enable_support-on'));
    expect(onChange).toHaveBeenCalledWith({ overrides: { enable_support: true } });
  });

  it('renders a per-extruder vector as one field per element', () => {
    const { onChange } = renderSheet();
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'nozzle temp' } });
    // Two fields because the preset's vector has two entries — never a guessed count.
    expect(screen.getByText('Extruder 1')).toBeTruthy();
    expect(screen.getByText('Extruder 2')).toBeTruthy();
    fireEvent.change(screen.getByTestId('field-nozzle_temperature'), {
      target: { value: '235' },
    });
    // The untouched element is carried through, and both arrive as numbers: the engine
    // reads the element type to choose `,` over `;` (SPEC deviation #25).
    expect(onChange).toHaveBeenCalledWith({ overrides: { nozzle_temperature: [235, 220] } });
  });

  it('marks a modified value and offers a revert that clears exactly it', () => {
    const { onChange } = renderSheet({
      state: { overrides: { layer_height: 0.28, seam_position: 'back' } },
    });
    fireEvent.click(screen.getByTestId('settings-group-Quality'));
    expect(screen.getByTestId('modified-layer_height')).toBeTruthy();
    expect(screen.getByTestId('setting-layer_height').dataset.modified).toBe('true');
    fireEvent.click(screen.getByTestId('revert-layer_height'));
    expect(onChange).toHaveBeenCalledWith({ overrides: { seam_position: 'back' } });
  });

  it('filters to just what was changed, whatever the disclosure level', () => {
    // `wall_loops` is an advanced option; having changed it, it must stay findable from
    // the Simple level — losing track of an override is how this UI would lie.
    renderSheet({ state: { overrides: { wall_loops: 4 } } });
    fireEvent.click(screen.getByTestId('modified-only'));
    expect(screen.getByTestId('setting-wall_loops')).toBeTruthy();
    expect(screen.queryByTestId('setting-layer_height')).toBeNull();
  });

  it('reverts everything at once', () => {
    const { onChange } = renderSheet({
      state: { overrides: { layer_height: 0.28, wall_loops: 4 } },
    });
    fireEvent.click(screen.getByTestId('settings-group-Quality'));
    fireEvent.click(screen.getByTestId('settings-reset-all'));
    expect(onChange).toHaveBeenCalledWith({ overrides: {} });
  });
});

describe('saved user presets', () => {
  const saved = {
    id: 'p1',
    name: 'Fast draft',
    overrides: { layer_height: 0.28 },
    basedOn: null,
    createdAt: '',
    updatedAt: '',
  };

  it('applies a saved set wholesale', () => {
    const { onChange } = renderSheet({ userPresets: [saved] });
    fireEvent.click(screen.getByTestId('row-saved-settings'));
    fireEvent.click(screen.getByTestId('apply-p1'));
    expect(onChange).toHaveBeenCalledWith({ overrides: { layer_height: 0.28 } });
  });

  it('will not save an empty diff', () => {
    renderSheet({ userPresets: [] });
    fireEvent.click(screen.getByTestId('row-saved-settings'));
    fireEvent.change(screen.getByTestId('preset-name'), { target: { value: 'Nothing' } });
    expect((screen.getByTestId('preset-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves the current diff under a name', () => {
    const onSavePreset = vi.fn().mockResolvedValue(undefined);
    renderSheet({ state: { overrides: { layer_height: 0.28 } }, onSavePreset });
    fireEvent.click(screen.getByTestId('row-saved-settings'));
    fireEvent.change(screen.getByTestId('preset-name'), { target: { value: 'Fast draft' } });
    fireEvent.click(screen.getByTestId('preset-save'));
    expect(onSavePreset).toHaveBeenCalledWith('Fast draft');
  });
});
