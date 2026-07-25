/**
 * Turning the CLI's log output into something a person can act on.
 *
 * The exit-code table (exit-codes.ts) is the primary mapping, but several real-world
 * failures share one generic code (or, worse, exit 0) and are only distinguishable by
 * the message the slicer printed. Those live here. A match always wins over the
 * exit-code mapping, because it is strictly more specific.
 */

import type { SliceErrorCode } from '@orca-web/shared';
import { SliceError } from '../errors.js';

interface DiagnosticRule {
  id: string;
  pattern: RegExp;
  code: SliceErrorCode;
  message: string;
  hint?: string;
  retryable?: boolean;
}

const RULES: readonly DiagnosticRule[] = [
  {
    // SPEC gotcha: "Some community profiles fail with a 'Relative extruder addressing
    // requires resetting the extruder position' error; the fix is ensuring `G92 E0` is
    // present in the layer-change G-code of the process profile." Without this rule the
    // user sees a bare CLI_SLICING_ERROR and has no idea what to change.
    id: 'relative-e-reset',
    pattern: /Relative extruder addressing requires resetting the extruder position/i,
    code: 'RELATIVE_E_RESET_REQUIRED',
    message:
      'This print profile uses relative extruder addressing but never resets the extruder position.',
    hint: "Add `G92 E0` to the layer-change G-code of the process profile (or turn off 'use relative E distances').",
  },
  {
    id: 'out-of-memory',
    pattern: /std::bad_alloc|Cannot allocate memory|out of memory/i,
    code: 'OUT_OF_MEMORY',
    message: 'The server ran out of memory slicing this model.',
    hint: 'Simplify the model or reduce its triangle count and try again.',
  },
  {
    id: 'empty-plate',
    pattern: /plate \d+ has no object|no object to slice/i,
    code: 'NO_PRINTABLE_OBJECTS',
    message: 'There is nothing on the plate to slice.',
    hint: 'Add a model to the plate and slice again.',
  },
  {
    id: 'object-outside',
    pattern:
      /objects? (?:is|are) (?:partly )?outside|outside the print area|exceeds the print area/i,
    code: 'OBJECT_OUTSIDE_BED',
    message: 'Some objects sit outside the printable area of the plate.',
    hint: 'Move or scale them so they sit fully on the plate.',
  },
];

/** The first matching rule, or `undefined` if the log says nothing we recognise. */
export function matchDiagnostic(log: string): SliceError | undefined {
  for (const rule of RULES) {
    if (!rule.pattern.test(log)) continue;
    return new SliceError(rule.code, rule.message, {
      ...(rule.hint === undefined ? {} : { hint: rule.hint }),
      retryable: rule.retryable ?? false,
      detail: `matched diagnostic rule "${rule.id}"\n${log}`,
    });
  }
  return undefined;
}

/** Rule ids, so tests can assert the table has not silently lost an entry. */
export const DIAGNOSTIC_RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);
