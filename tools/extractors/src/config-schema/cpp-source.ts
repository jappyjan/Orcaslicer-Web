/**
 * Just enough C++ lexing to walk `PrintConfig.cpp` safely.
 *
 * `PrintConfig.cpp` is 11.6k lines of a hand-written, highly repetitive builder idiom.
 * A real C++ parser would be absurd here; a tolerant, idiom-aware scanner is right.
 * What it must not do is get confused by `;`, `{` or `//` inside a string literal —
 * upstream embeds whole G-code programs and tooltips full of punctuation in them.
 */

/**
 * Replace every comment with spaces, preserving byte offsets (and therefore line
 * numbers) and every string/char literal verbatim.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      while (i < stop) {
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return stripPreprocessor(out.join(''));
}

/**
 * Blank out preprocessor directives, keeping byte offsets.
 *
 * They are not statements, and leaving them in makes the statement splitter glue an
 * `#if … #endif` block onto the definition that follows it — which is exactly how
 * `load_custom_gcodes` disappears from the CLI options if you skip this step.
 * Line continuations (`\` at end of line) are followed.
 */
export function stripPreprocessor(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const lineEnd = src.indexOf('\n', i);
    const end = lineEnd === -1 ? src.length : lineEnd;
    if (/^\s*#/.test(src.slice(i, end))) {
      let stop = end;
      // Follow `\`-continued lines.
      while (/\\\s*$/.test(src.slice(i, stop))) {
        const next = src.indexOf('\n', stop + 1);
        const nextEnd = next === -1 ? src.length : next;
        blank(i, stop);
        i = stop + 1;
        stop = nextEnd;
      }
      blank(i, stop);
      i = stop + 1;
      continue;
    }
    i = end + 1;
  }
  return out.join('');
}

/** Maps byte offsets to 1-based line numbers. */
export class LineIndex {
  private readonly starts: number[];

  constructor(src: string) {
    this.starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.starts.push(i + 1);
  }

  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

export interface Statement {
  /** Whitespace-collapsed statement text, without the trailing `;`. */
  text: string;
  /** Byte offset of the first character. */
  offset: number;
  /** Brace nesting relative to the enclosing function body (0 = top level of the body). */
  depth: number;
}

/**
 * Split `[from, to)` of a comment-stripped source into `;`-terminated statements,
 * ignoring separators inside string literals or parentheses.
 */
export function splitStatements(src: string, from: number, to: number): Statement[] {
  const statements: Statement[] = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let start = -1;
  for (let i = from; i < to; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      if (start === -1) start = i;
      const quote = c;
      i++;
      while (i < to) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[') parenDepth++;
    else if (c === ')' || c === ']') parenDepth = Math.max(0, parenDepth - 1);
    else if (c === '{' && parenDepth === 0) {
      braceDepth++;
      start = -1;
      continue;
    } else if (c === '}' && parenDepth === 0) {
      braceDepth = Math.max(0, braceDepth - 1);
      start = -1;
      continue;
    } else if (c === ';' && parenDepth === 0) {
      if (start !== -1) {
        const raw = src.slice(start, i);
        const text = raw.replace(/\s+/g, ' ').trim();
        if (text) statements.push({ text, offset: start, depth: Math.max(0, braceDepth - 1) });
      }
      start = -1;
      continue;
    }
    if (start === -1 && !/\s/.test(c as string)) start = i;
  }
  return statements;
}

/** A member-function or constructor body: `Foo::bar(...) { … }`. */
export interface SourceSection {
  className: string;
  functionName: string;
  /** Offset just after the opening brace of the body. */
  bodyStart: number;
  /** Offset of the matching closing brace. */
  bodyEnd: number;
}

// Return type (if any) must be followed by whitespace/`*`/`&`, otherwise a lazy prefix
// would eat the first character of the class name and every `Foo::Foo()` constructor
// would be attributed to a class called `oo`.
const DEFINITION_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_:<>]*[\s*&]+)*([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_~][A-Za-z0-9_]*)\s*\(/gm;

/** Locate every top-level `Class::function(...) { … }` body in a comment-stripped source. */
export function findSections(src: string): SourceSection[] {
  const sections: SourceSection[] = [];
  DEFINITION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFINITION_RE.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + m[0].length);
    if (open === -1) continue;
    // Guard against matching a declaration whose `{` belongs to a later definition.
    const between = src.slice(m.index + m[0].length, open);
    if (between.includes(';')) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i++;
        while (i < src.length) {
          if (src[i] === '\\') {
            i += 2;
            continue;
          }
          if (src[i] === quote) break;
          i++;
        }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    sections.push({
      className: m[1] as string,
      functionName: m[2] as string,
      bodyStart: open + 1,
      bodyEnd: end,
    });
  }
  return sections;
}

// Upstream writes degree/superscript units as UTF-8 literals: `u8"°"`, `L(u8"mm³/s")`.
const STRING_LITERAL_RE = /(?:u8|u|U)?"((?:[^"\\]|\\.)*)"/g;

function unescape(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_all, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case '"':
        return '"';
      case "'":
        return "'";
      case '\\':
        return '\\';
      case 'u':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      case 'x':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        return esc;
    }
  });
}

/**
 * Evaluate a C++ expression that is (possibly translation-wrapped) string literals:
 * `L("a" "b")`, `_L("x")`, `"plain"`. Returns `null` for anything else — a computed
 * label is a gap to report, not something to guess at.
 */
export function parseStringExpression(expr: string): string | null {
  let e = expr.trim();
  // Strip translation wrappers — L( … ), _L( … ), _( … ), _u8L( … ) — and bare
  // parentheses, which upstream also writes (`def->sidetext = ("%");`).
  for (;;) {
    const m = /^(?:_?_?u8L|_L|L|_)?\s*\(([\s\S]*)\)$/.exec(e);
    if (!m) break;
    const inner = (m[1] as string).trim();
    if (inner === e) break;
    e = inner;
  }
  const pieces: string[] = [];
  let cursor = 0;
  STRING_LITERAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRING_LITERAL_RE.exec(e)) !== null) {
    const gap = e.slice(cursor, m.index).trim();
    // Only whitespace may separate adjacent literals; anything else means the value
    // is computed (concatenations with variables, ternaries, …).
    if (gap !== '') return null;
    pieces.push(unescape(m[1] as string));
    cursor = m.index + m[0].length;
  }
  if (pieces.length === 0) return null;
  if (e.slice(cursor).trim() !== '') return null;
  return pieces.join('');
}

/** Named C++ numeric constants used in `min`/`max`/default expressions in PrintConfig.cpp. */
const NUMERIC_CONSTANTS: Record<string, number> = {
  FLT_MAX: 3.402823466e38,
  'FLT_MAX/2': 1.701411733e38,
  DBL_MAX: Number.MAX_VALUE,
  INT_MAX: 2147483647,
  INT_MIN: -2147483648,
  'std::numeric_limits<int>::max()': 2147483647,
  'std::numeric_limits<double>::max()': Number.MAX_VALUE,
  NaN: Number.NaN,
  nan: Number.NaN,
};

/** Evaluate a numeric literal or a known named constant. Returns `null` if computed. */
export function parseNumberExpression(expr: string): number | null {
  const e = expr.trim().replace(/\s+/g, '');
  if (e in NUMERIC_CONSTANTS) return NUMERIC_CONSTANTS[e] as number;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[fFlLuU]?$/.exec(e);
  if (m) return Number(m[1]);
  return null;
}

/** Split a comma-separated argument list, respecting nesting and string literals. */
export function splitArguments(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let angle = 0;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < argText.length) {
        if (argText[i] === '\\') {
          i += 2;
          continue;
        }
        if (argText[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    // Template brackets: only ever seen as `ConfigOptionEnum<T>`, and `>` never
    // decrements below zero so a stray comparison cannot swallow the whole list.
    else if (c === '<') angle++;
    else if (c === '>' && angle > 0) angle--;
    else if (c === ',' && depth === 0 && angle === 0) {
      args.push(argText.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = argText.slice(start).trim();
  if (last !== '' || args.length > 0) args.push(last);
  return args;
}
