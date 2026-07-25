import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_RULE_IDS, matchDiagnostic } from './diagnostics.js';

describe('matchDiagnostic', () => {
  // SPEC gotcha: some community profiles fail with this message; the fix is a `G92 E0`
  // in the process profile's layer-change G-code. Without this rule the user would see
  // an untyped slicing failure and have nothing to act on.
  it('turns the relative-extruder failure into an actionable message', () => {
    const error = matchDiagnostic(
      'ERROR: Relative extruder addressing requires resetting the extruder position at each layer change.',
    );
    expect(error?.code).toBe('RELATIVE_E_RESET_REQUIRED');
    expect(error?.hint).toContain('G92 E0');
    // The user gets the hint, not the raw log line.
    expect(error?.toApiError().message).not.toContain('ERROR:');
    expect(error?.detail).toContain('Relative extruder addressing');
  });

  it('recognises an out-of-memory failure', () => {
    expect(matchDiagnostic('terminate called after throwing std::bad_alloc')?.code).toBe(
      'OUT_OF_MEMORY',
    );
  });

  it('returns undefined for output it does not recognise', () => {
    expect(matchDiagnostic('Slicing plate 1\nExporting 3mf\n')).toBeUndefined();
  });

  it('keeps every rule reachable', () => {
    expect(new Set(DIAGNOSTIC_RULE_IDS).size).toBe(DIAGNOSTIC_RULE_IDS.length);
    expect(DIAGNOSTIC_RULE_IDS).toContain('relative-e-reset');
  });
});
