/**
 * Regression tests for the override serialiser.
 *
 * Every assertion here corresponds to something measured against the pinned 2.4.2 binary
 * (see the module header, and SPEC deviations #23 and #27). The failure modes they guard
 * are all *quiet*: a naive `--key value` serialiser reports `No such file: 0`, which
 * reads as a missing model rather than a rejected setting, and a naive `;`-joined vector
 * exits 0 having thrown away every element but the first.
 */

import { describe, expect, it } from 'vitest';
import { SliceError } from '../errors.js';
import { overrideArgs, serialiseOverride, vectorSeparator } from './overrides.js';

describe('overrideArgs', () => {
  it('emits exactly one argv token per override', () => {
    expect(overrideArgs({ layer_height: 0.28 })).toEqual(['--layer-height=0.28']);
  });

  it('kebab-cases the key', () => {
    expect(overrideArgs({ sparse_infill_pattern: 'gyroid' })).toEqual([
      '--sparse-infill-pattern=gyroid',
    ]);
  });

  it('sorts keys so a command line is reproducible', () => {
    expect(overrideArgs({ wall_loops: 3, layer_height: 0.1 })).toEqual([
      '--layer-height=0.1',
      '--wall-loops=3',
    ]);
  });

  it('rejects anything that is not a config key', () => {
    // The key is interpolated into argv, so this is a boundary, not a nicety.
    for (const key of ['Layer_Height', 'layer-height', '--layer-height', 'a b', '', '1x']) {
      expect(() => overrideArgs({ [key]: 1 })).toThrow(SliceError);
    }
  });

  // -- SPEC deviation #23 ----------------------------------------------------

  describe('booleans (SPEC deviation #23)', () => {
    it('turns one ON as a single token', () => {
      expect(overrideArgs({ enable_support: true })).toEqual(['--enable-support=1']);
    });

    it('turns one OFF with the = form — the case a naive serialiser breaks', () => {
      // MEASURED: `--use-relative-e-distances 0` exits 253 with `No such file: 0`, because
      // the 0 is taken as a positional model path.
      expect(overrideArgs({ use_relative_e_distances: false })).toEqual([
        '--use-relative-e-distances=0',
      ]);
    });

    it('never emits a separate value token for a boolean', () => {
      const args = overrideArgs({ enable_arc_fitting: false, enable_support: true });
      expect(args).toEqual(['--enable-arc-fitting=0', '--enable-support=1']);
      // The property that actually matters: nothing in the output is a bare `0`/`1` that
      // the CLI would read as a file name.
      expect(args.some((arg) => arg === '0' || arg === '1')).toBe(false);
      expect(args.every((arg) => arg.startsWith('--'))).toBe(true);
    });

    it('serialises boolean vector elements as 1/0 too', () => {
      // `coBools` is a switch as well: `--filament-soluble 1,0` fails identically.
      expect(overrideArgs({ filament_soluble: [true, false] })).toEqual(['--filament-soluble=1,0']);
    });
  });

  // -- SPEC deviation #27 ----------------------------------------------------

  describe('vectors (SPEC deviation #27)', () => {
    it('joins numeric vectors with a comma', () => {
      // `;` here yields a ONE-element vector at exit 0 — silent data loss.
      expect(overrideArgs({ nozzle_temperature: [235, 240] })).toEqual([
        '--nozzle-temperature=235,240',
      ]);
    });

    it('joins numeric-looking string vectors with a comma', () => {
      // Presets store numbers as strings ("220"), so the round trip must not change the
      // separator just because the value came back off the wire as text.
      expect(overrideArgs({ nozzle_temperature: ['235', '240'] })).toEqual([
        '--nozzle-temperature=235,240',
      ]);
    });

    it('joins string vectors with a semicolon', () => {
      expect(overrideArgs({ filament_notes: ['dry me', 'then print'] })).toEqual([
        '--filament-notes=dry me;then print',
      ]);
    });

    it('joins point vectors with a comma', () => {
      // `--printable-area=0x0;180x0;…` exits 206 (-50) and writes no artefact at all.
      expect(overrideArgs({ printable_area: ['0x0', '180x0', '180x180', '0x180'] })).toEqual([
        '--printable-area=0x0,180x0,180x180,0x180',
      ]);
    });

    it('sends a one-element vector unadorned', () => {
      expect(overrideArgs({ nozzle_temperature: [235] })).toEqual(['--nozzle-temperature=235']);
    });
  });

  describe('nullable options', () => {
    it('writes nil, not an empty value', () => {
      // MEASURED: `--filament-retraction-length=nil` -> ["nil"]; the empty form -> ["0"],
      // which is a real retraction distance and the opposite of "unset".
      expect(overrideArgs({ filament_retraction_length: null })).toEqual([
        '--filament-retraction-length=nil',
      ]);
    });
  });

  describe('strings', () => {
    it('keeps a multi-line custom G-code block in one token', () => {
      const gcode = ';M6\nG92 E0';
      expect(overrideArgs({ layer_change_gcode: gcode })).toEqual([
        `--layer-change-gcode=${gcode}`,
      ]);
    });

    it('keeps a negative number in one token', () => {
      // Two tokens would make `-0.05` look like a flag.
      expect(overrideArgs({ z_offset: -0.05 })).toEqual(['--z-offset=-0.05']);
    });

    it('falls back to two tokens for an empty string', () => {
      // MEASURED: `--filament-notes=` exits 253 and swallows the NEXT argument.
      expect(overrideArgs({ filament_notes: '' })).toEqual(['--filament-notes', '']);
    });
  });
});

describe('vectorSeparator', () => {
  it('picks a comma for numbers and numeric strings', () => {
    expect(vectorSeparator([1, 2])).toBe(',');
    expect(vectorSeparator(['0.8', '0.8'])).toBe(',');
    expect(vectorSeparator([true, false])).toBe(',');
  });

  it('treats percentages and point literals as comma-separated', () => {
    expect(vectorSeparator(['15%', '20%'])).toBe(',');
    expect(vectorSeparator(['0x0', '180x0'])).toBe(',');
  });

  it('picks a semicolon as soon as an element is genuinely a string', () => {
    expect(vectorSeparator(['PLA', 'PETG'])).toBe(';');
    expect(vectorSeparator(['#FF0000', '#0000FF'])).toBe(';');
  });
});

describe('serialiseOverride', () => {
  it('round-trips the scalar shapes', () => {
    expect(serialiseOverride(0.28)).toBe('0.28');
    expect(serialiseOverride('gyroid')).toBe('gyroid');
    expect(serialiseOverride(true)).toBe('1');
    expect(serialiseOverride(false)).toBe('0');
    expect(serialiseOverride(null)).toBe('nil');
  });
});
