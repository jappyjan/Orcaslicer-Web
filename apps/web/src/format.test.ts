import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatGrams, formatMetres } from './format.ts';

describe('formatting', () => {
  it('formats a print-time prediction', () => {
    // 873 s is what a real 20 mm cube reported on a Bambu H2S.
    expect(formatDuration(873)).toBe('14 min 33 s');
    expect(formatDuration(9412)).toBe('2 h 36 min');
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('keeps small masses and lengths precise and big ones readable', () => {
    expect(formatGrams(3.66)).toBe('3.66 g');
    expect(formatGrams(42.5)).toBe('42.5 g');
    expect(formatGrams(1234)).toBe('1234 g');
    expect(formatMetres(1.21)).toBe('1.21 m');
    expect(formatMetres(123.4)).toBe('123 m');
  });

  it('formats artefact sizes', () => {
    expect(formatBytes(684)).toBe('684 B');
    expect(formatBytes(58564)).toBe('57 kB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
  });
});
