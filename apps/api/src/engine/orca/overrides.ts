/**
 * Turning M6's diff into OrcaSlicer CLI arguments.
 *
 * This is the whole of "diff-and-override": the settings UI computes which keys differ
 * from the resolved preset and sends only those, and this module turns them into flags.
 * Nothing writes a profile file — SPEC's settings priority puts command-line flags above
 * `--load-settings` files, so a flag is both the smallest and the highest-priority way to
 * change one value, and hard constraint #1 forbids writing into OrcaSlicer's own tree.
 *
 * Everything below was MEASURED against the pinned 2.4.2 binary, because every plausible
 * guess about the argument syntax is wrong in a different way:
 *
 *  - **`--key value` is not safe.** Every `coBool`/`coBools` key is registered with an
 *    implicit value, so boost's parser does not consume the following token as the flag's
 *    value — it takes it as a *positional model path*. `--use-relative-e-distances 0`
 *    dies with `No such file: 0` (shell status 253) and `--filament-soluble "1,0"` with
 *    `No such file: 1,0`. That is SPEC deviation #23, and it produces an error message
 *    that looks nothing like a validation failure.
 *  - **`--key=value` is universal.** Measured working for `coFloat`, `coInt`, `coEnum`,
 *    `coPercent`, `coBool`, `coBools`, `coInts`, `coFloats`, `coPoints`, `coString`
 *    (including multi-line custom G-code) and negative numbers. So this module emits one
 *    argv token per override and never a `--key value` pair. That subsumes deviation
 *    #23's "bare flag to turn on, `=` form to turn off" — `--key=1` turns one on just as
 *    well and needs no special case in the caller.
 *  - **Vector separators depend on the element type** (SPEC deviation #25). Numeric and
 *    point vectors split on `,`; string vectors split on `;`. Getting it backwards is
 *    silent for numbers — `--nozzle-temperature "235;240"` yields the one-element vector
 *    `["235"]` at exit 0 — and fatal for points, where `--printable-area "0x0;180x0;…"`
 *    exits 206 (`-50`) with no artefact.
 *  - **`--key=` with nothing after the `=` is rejected**, and takes the *next* argument
 *    with it (`No such file: /work/…/out.gcode.3mf`, status 253). An empty string is a
 *    legal value, so it is the one case that goes back to the two-token form — which is
 *    safe precisely because no string option is a switch.
 */

import type { SettingValue } from '@orca-web/shared';
import { SliceError } from '../errors.js';

/** A config key: lower-case identifier, exactly as `PrintConfig.cpp` spells it. */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * How a vector's elements are joined.
 *
 * MEASURED on 2.4.2 by reading `Metadata/project_settings.config` back out of the
 * archive, which is the fully resolved config the slice actually ran with:
 *
 * | flag                                        | resulting value          |
 * | ------------------------------------------- | ------------------------ |
 * | `--nozzle-temperature=235,240`              | `["235","240"]`          |
 * | `--nozzle-temperature=235;240`              | `["235"]`  ← silent loss |
 * | `--filament-notes=hello; world`             | `["hello","world"]`      |
 * | `--filament-notes=hello, world`             | `["hello, world"]`       |
 * | `--printable-area=0x0,180x0,180x180,0x180`  | 4 points                 |
 * | `--printable-area=0x0;180x0;180x180;0x180`  | exit 206, no output      |
 *
 * which is libslic3r's own split: `ConfigOptionVector<std::string>` unescapes a
 * `;`-separated list, every other vector type reads a `,`-separated one.
 */
export function vectorSeparator(values: ReadonlyArray<string | number | boolean>): ';' | ',' {
  return values.some((value) => typeof value === 'string' && !isNumericish(value)) ? ';' : ',';
}

/**
 * True for anything libslic3r reads with a `,`-separated vector deserialiser: plain
 * numbers, percentages (`15%`), and the `XxY` literal a `coPoint` serialises to. A value
 * that is none of those is genuinely a string, and string vectors split on `;`.
 */
function isNumericish(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  if (Number.isFinite(Number(text))) return true;
  if (/^-?[\d.]+%$/.test(text)) return true;
  // A point: `0x0`, `256x256`, `-1.5x2`.
  return /^-?[\d.]+x-?[\d.]+$/.test(text);
}

/** One value, in the text form the CLI's own deserialiser expects. */
export function serialiseOverride(value: SettingValue): string {
  // `nil` is libslic3r's spelling of "unset" for a nullable option — the `filament_*`
  // twins of an extruder setting. MEASURED: `--filament-retraction-length=nil` round-trips
  // as `["nil"]`, while an empty value silently becomes `["0"]`, which is a real
  // retraction distance and not "unset" at all.
  if (value === null) return 'nil';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) {
    const parts = (value as ReadonlyArray<string | number | boolean>).map((element) =>
      typeof element === 'boolean' ? (element ? '1' : '0') : String(element),
    );
    return parts.join(vectorSeparator(value as ReadonlyArray<string | number | boolean>));
  }
  return String(value);
}

/**
 * `{ layer_height: 0.28, enable_arc_fitting: false }` →
 * `['--layer-height=0.28', '--enable-arc-fitting=0']`.
 *
 * Order is stable (keys sorted) so a command line is reproducible and diffable in logs.
 */
export function overrideArgs(overrides: Readonly<Record<string, SettingValue>>): string[] {
  const args: string[] = [];
  for (const key of Object.keys(overrides).sort()) {
    if (!KEY_PATTERN.test(key)) {
      throw new SliceError('INVALID_PARAMS', `"${key}" is not a valid setting name.`, {
        hint: 'Setting names are lower-case identifiers such as `layer_height`.',
      });
    }
    const value = overrides[key] as SettingValue;
    if (value === undefined) continue;
    const flag = `--${key.replace(/_/g, '-')}`;
    const text = serialiseOverride(value);
    if (text === '') {
      // `--key=` is rejected AND eats the following argument. Two tokens instead; safe
      // because only a string-valued option can be empty and no string option is a switch.
      args.push(flag, '');
      continue;
    }
    args.push(`${flag}=${text}`);
  }
  return args;
}
