import { describe, expect, it } from 'vitest';
import {
  WordScanner,
  commentValue,
  configValue,
  isMarker,
  lines,
  parseSignedDecimal,
} from './tokenize.js';

function words(line: string): Array<[string, number]> {
  const scanner = new WordScanner();
  scanner.reset(line);
  const out: Array<[string, number]> = [];
  while (scanner.next()) out.push([scanner.letter, scanner.value]);
  return out;
}

describe('parseSignedDecimal', () => {
  // SPEC verified deviation #4: OrcaSlicer writes E values with no leading digit.
  const cases: Array<[string, number]> = [
    ['.02345', 0.02345],
    ['-.8', -0.8],
    ['+.5', 0.5],
    ['0.02345', 0.02345],
    ['50', 50],
    ['-0.5', -0.5],
    ['1.', 1],
    ['138.84475', 138.84475],
    ['0', 0],
    ['-0', -0],
  ];
  for (const [text, expected] of cases) {
    it(`parses ${text}`, () => {
      expect(parseSignedDecimal(text, 0, text.length)).toBeCloseTo(expected, 10);
    });
  }

  it('is NaN when there is no digit at all', () => {
    expect(parseSignedDecimal('-', 0, 1)).toBeNaN();
    expect(parseSignedDecimal('', 0, 0)).toBeNaN();
  });
});

describe('WordScanner', () => {
  it('reads a real extruding move with a leading-dot E', () => {
    expect(words('G1 X115.304 Y133.508 E.27553')).toEqual([
      ['G', 1],
      ['X', 115.304],
      ['Y', 133.508],
      ['E', 0.27553],
    ]);
  });

  it('reads a real arc', () => {
    expect(words('G2 X117.212 Y136.067 I12.395 J-7.248 E.12012')).toEqual([
      ['G', 2],
      ['X', 117.212],
      ['Y', 136.067],
      ['I', 12.395],
      ['J', -7.248],
      ['E', 0.12012],
    ]);
  });

  it('stops at a comment', () => {
    expect(words('G1 E-.8 F1800 ; retract X999')).toEqual([
      ['G', 1],
      ['E', -0.8],
      ['F', 1800],
    ]);
  });

  it('yields NaN for a letter with no number', () => {
    const scanned = words('G28 X Y');
    expect(scanned[0]).toEqual(['G', 28]);
    expect(scanned[1]?.[0]).toBe('X');
    expect(scanned[1]?.[1]).toBeNaN();
  });

  it('does not treat E as an exponent', () => {
    // `X1E2` is X=1 then E=2, never 100. Emitted G-code never contains it, but a parser
    // that guessed otherwise would silently move the head a hundred times too far.
    expect(words('G1 X1E2')).toEqual([
      ['G', 1],
      ['X', 1],
      ['E', 2],
    ]);
  });
});

describe('comment markers', () => {
  it('reads the 2.4.2 spelling, with its leading space', () => {
    expect(commentValue('; FEATURE: Outer wall', 'FEATURE')).toBe('Outer wall');
    expect(commentValue('; Z_HEIGHT: 0.2', 'Z_HEIGHT')).toBe('0.2');
    expect(commentValue('; LINE_WIDTH: 0.393713', 'LINE_WIDTH')).toBe('0.393713');
  });

  it('reads the legacy PrusaSlicer spelling too', () => {
    expect(commentValue(';TYPE:External perimeter', 'TYPE')).toBe('External perimeter');
    expect(commentValue(';Z:0.4', 'Z')).toBe('0.4');
  });

  it('does not match a different key or a prose comment', () => {
    expect(commentValue('; FEATURE_X: 1', 'FEATURE')).toBeUndefined();
    expect(commentValue('; the feature is nice', 'FEATURE')).toBeUndefined();
    expect(commentValue('G1 X1 ; FEATURE: Outer wall', 'FEATURE')).toBeUndefined();
  });

  it('recognises bare markers', () => {
    expect(isMarker('; CHANGE_LAYER', 'CHANGE_LAYER')).toBe(true);
    expect(isMarker(';LAYER_CHANGE', 'LAYER_CHANGE')).toBe(true);
    expect(isMarker('; CHANGE_LAYER_NOT', 'CHANGE_LAYER')).toBe(false);
  });

  it('reads config-block keys', () => {
    expect(configValue('; nozzle_diameter = 0.4', 'nozzle_diameter')).toBe('0.4');
    expect(configValue('; filament_colour = #F2754E', 'filament_colour')).toBe('#F2754E');
    expect(configValue('; bed_custom_texture = ', 'bed_custom_texture')).toBe('');
    // `; Z_HEIGHT: 0.2` is a marker, not a config key.
    expect(configValue('; Z_HEIGHT: 0.2', 'Z_HEIGHT')).toBeUndefined();
  });
});

describe('lines', () => {
  async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield new TextEncoder().encode(part);
  }

  it('splits across chunk boundaries and strips CRLF', async () => {
    const out: string[] = [];
    for await (const line of lines(chunks('G1 X1\r\nG1 ', 'X2\nG1 X3'))) out.push(line);
    expect(out).toEqual(['G1 X1', 'G1 X2', 'G1 X3']);
  });

  it('does not emit a trailing empty line', async () => {
    const out: string[] = [];
    for await (const line of lines(chunks('a\nb\n'))) out.push(line);
    expect(out).toEqual(['a', 'b']);
  });
});
