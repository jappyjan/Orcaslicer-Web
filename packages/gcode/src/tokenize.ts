/**
 * Scanning one line of G-code.
 *
 * VERIFIED DEVIATION #4 (docs/SPEC.md): OrcaSlicer writes extrusion amounts with no
 * leading digit — `E.02345`, `E-.8` — so the obvious `E[0-9.]+` / `^G1 .*E[0-9]` regexes
 * miss almost every extrusion. Measured on our own binary: 3 764 of the 4 028 E words in
 * a 15-layer slice have no leading digit.
 *
 * The answer is not a cleverer regex. This scanner reads a word as "one letter, then the
 * longest run of `+ - . 0-9`", and converts that run itself, so `.02345`, `-.8`, `50`
 * and `0.5` are all just numbers. There is no pattern to get subtly wrong, and it is
 * roughly four times faster than a regex over 1.5 million lines.
 *
 * Exponent notation is deliberately NOT accepted: `E` is a G-code word letter, so
 * treating `E` as an exponent marker inside a number would misparse `X1E2` — which
 * cannot occur in emitted G-code but would silently corrupt a coordinate if it did.
 */

/** Neither a G-code word letter nor a number: the line has no words after this point. */
const CHAR_SEMICOLON = 0x3b;

function isDigitOrSign(code: number): boolean {
  // 0-9 . + -
  return (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2b || code === 0x2d;
}

function isLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * A mutable cursor over one line. Reused across the whole file — allocating a token
 * object per word would dominate the parse of a 40 MB input.
 */
export class WordScanner {
  private line = '';
  private pos = 0;
  private end = 0;

  /** Upper-case letter of the word just read. */
  letter = '';
  /** Its value. `NaN` when the word carried no number (e.g. a bare `G` or `T`). */
  value = 0;

  /** Point the scanner at a line, stopping at the first `;`. */
  reset(line: string): void {
    this.line = line;
    this.pos = 0;
    const comment = line.indexOf(';');
    this.end = comment === -1 ? line.length : comment;
  }

  /** Advance to the next word. False when the line is exhausted. */
  next(): boolean {
    const { line } = this;
    let i = this.pos;
    while (i < this.end) {
      const code = line.charCodeAt(i);
      if (code === CHAR_SEMICOLON) break;
      if (isLetter(code)) break;
      i += 1;
    }
    if (i >= this.end) {
      this.pos = i;
      return false;
    }

    this.letter = line[i] as string;
    if (this.letter >= 'a' && this.letter <= 'z') {
      this.letter = this.letter.toUpperCase();
    }
    i += 1;

    const numberStart = i;
    while (i < this.end && isDigitOrSign(line.charCodeAt(i))) i += 1;
    this.value = i === numberStart ? Number.NaN : parseSignedDecimal(line, numberStart, i);
    this.pos = i;
    return true;
  }
}

/**
 * `[+-]?digits[.digits]` out of `line[start, end)`.
 *
 * Hand-rolled rather than `Number.parseFloat(line.slice(...))` because the slice is an
 * allocation per word: 6.8 million of them on the 42 MiB budget file. `parseFloat` would
 * accept this input too — the leading-dot form is only a problem for regexes — so this
 * is purely about not allocating.
 */
export function parseSignedDecimal(line: string, start: number, end: number): number {
  let i = start;
  let sign = 1;
  if (i < end) {
    const code = line.charCodeAt(i);
    if (code === 0x2d) {
      sign = -1;
      i += 1;
    } else if (code === 0x2b) {
      i += 1;
    }
  }

  let integer = 0;
  let sawDigit = false;
  while (i < end) {
    const code = line.charCodeAt(i);
    if (code < 0x30 || code > 0x39) break;
    integer = integer * 10 + (code - 0x30);
    sawDigit = true;
    i += 1;
  }

  if (i < end && line.charCodeAt(i) === 0x2e) {
    i += 1;
    let fraction = 0;
    let divisor = 1;
    while (i < end) {
      const code = line.charCodeAt(i);
      if (code < 0x30 || code > 0x39) break;
      fraction = fraction * 10 + (code - 0x30);
      divisor *= 10;
      sawDigit = true;
      i += 1;
    }
    // `E.02345` lands here with integer = 0: the leading digit is genuinely absent, not
    // implied, and the value is exactly fraction/divisor.
    integer += fraction / divisor;
  }

  return sawDigit ? sign * integer : Number.NaN;
}

/**
 * Payload of a `; KEY: value` or `;KEY:value` comment, or `undefined`.
 *
 * MEASURED: 2.4.2 writes `; FEATURE: Outer wall` and `; Z_HEIGHT: 0.2` with a leading
 * space; the legacy form other slicers use is `;TYPE:Outer wall` with none. Both are
 * accepted, and the key match is case-sensitive because every marker upstream emits is
 * upper-case and matching loosely would collide with prose comments.
 */
export function commentValue(line: string, key: string): string | undefined {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i += 1;
  if (line.charCodeAt(i) !== CHAR_SEMICOLON) return undefined;
  i += 1;
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i += 1;
  if (!line.startsWith(key, i)) return undefined;
  i += key.length;
  if (line.charCodeAt(i) !== 0x3a) return undefined; // ':'
  i += 1;
  return line.slice(i).trim();
}

/** True when the line is exactly the given bare marker, e.g. `; CHANGE_LAYER`. */
export function isMarker(line: string, marker: string): boolean {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i += 1;
  if (line.charCodeAt(i) !== CHAR_SEMICOLON) return false;
  i += 1;
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i += 1;
  if (!line.startsWith(marker, i)) return false;
  const rest = line.slice(i + marker.length).trim();
  return rest === '';
}

/**
 * Payload of a `; key = value` line from the header's `CONFIG_BLOCK`.
 * Returns `undefined` for anything else, including the `; KEY: value` markers.
 */
export function configValue(line: string, key: string): string | undefined {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i += 1;
  if (line.charCodeAt(i) !== CHAR_SEMICOLON) return undefined;
  i += 1;
  while (i < line.length && line.charCodeAt(i) === 0x20) i += 1;
  if (!line.startsWith(key, i)) return undefined;
  i += key.length;
  while (i < line.length && line.charCodeAt(i) === 0x20) i += 1;
  if (line.charCodeAt(i) !== 0x3d) return undefined; // '='
  return line.slice(i + 1).trim();
}

/** Split a byte stream into lines without ever holding more than one chunk as a string. */
export async function* lines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('latin1');
  let carry = '';
  for await (const chunk of source) {
    // latin1 is byte-per-character: a multi-byte sequence can never be split across
    // chunks, so no stateful decoding is needed and every byte maps to one char.
    const text = carry + decoder.decode(chunk);
    let start = 0;
    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;
      const end = newline > start && text.charCodeAt(newline - 1) === 0x0d ? newline - 1 : newline;
      yield text.slice(start, end);
      start = newline + 1;
    }
    carry = text.slice(start);
  }
  if (carry !== '') yield carry;
}
