/**
 * Evaluate `compatible_printers_condition` / `compatible_prints_condition`.
 *
 * These are PlaceholderParser boolean expressions evaluated against the *printer*
 * config. In 2.4.2's profile tree there are exactly 42 distinct condition strings and
 * they use a small subset of the grammar, e.g.
 *
 * ```
 * printer_notes=~/.*MK4S.*./ and nozzle_diameter[0]==0.4 and printer_notes!~/.*HF_NOZZLE.*./
 * printer_notes=~/.*PRINTER_MODEL_COREONE[^_a-zA-Z0-9].*./ and nozzle_diameter[0]==0.25
 * printer_notes=~/.*MK4S.*./ and nozzle_diameter[0]==0.4 and single_extruder_multi_material
 * ```
 *
 * so this is a small recursive-descent parser for
 * `or`/`and`/`not`, parentheses, comparisons (`== != < > <= >=`), regex match
 * (`=~` / `!~`), bare booleans, indexed keys (`k[0]`), numbers and quoted strings.
 *
 * Anything it cannot parse or evaluate is reported (never silently treated as false):
 * an unknown condition yields `{ value: true, evaluated: false }` so the preset stays
 * visible and shows up in the catalog report rather than vanishing from the UI.
 */

export interface ConditionResult {
  value: boolean;
  evaluated: boolean;
  error?: string;
}

/** Reads a value out of a resolved printer config. */
export type ConfigLookup = (key: string, index: number | null) => unknown;

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' };

const OPERATORS = ['<=', '>=', '==', '!=', '=~', '!~', '<', '>', '='];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (c === '[') {
      tokens.push({ kind: 'lbracket' });
      i++;
      continue;
    }
    if (c === ']') {
      tokens.push({ kind: 'rbracket' });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') {
          out += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        out += src[j];
        j++;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    // A `/` only starts a regex right after a match operator.
    const prev = tokens[tokens.length - 1];
    if (c === '/' && prev && prev.kind === 'op' && (prev.value === '=~' || prev.value === '!~')) {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '/') {
        if (src[j] === '\\') {
          out += src[j] as string;
          out += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        out += src[j];
        j++;
      }
      tokens.push({ kind: 'regex', value: out });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    const num = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(src.slice(i));
    if (num && /[\d]/.test(c)) {
      tokens.push({ kind: 'number', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_]\w*/.exec(src.slice(i));
    if (ident) {
      tokens.push({ kind: 'ident', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    throw new Error(`unexpected character '${c}' at ${i}`);
  }
  return tokens;
}

type Value = string | number | boolean | null;

function toNumber(v: Value): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function toBoolean(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0' && v !== 'false' && v !== 'nil';
  return false;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly lookup: ConfigLookup,
  ) {}

  parse(): boolean {
    const value = this.parseOr();
    if (this.pos !== this.tokens.length) throw new Error('trailing tokens in expression');
    return toBoolean(value);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseOr(): Value {
    let left = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'ident' && (t.value === 'or' || t.value === '||')) {
        this.pos++;
        const right = this.parseAnd();
        left = toBoolean(left) || toBoolean(right);
        continue;
      }
      return left;
    }
  }

  private parseAnd(): Value {
    let left = this.parseNot();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'ident' && (t.value === 'and' || t.value === '&&')) {
        this.pos++;
        const right = this.parseNot();
        left = toBoolean(left) && toBoolean(right);
        continue;
      }
      return left;
    }
  }

  private parseNot(): Value {
    const t = this.peek();
    if (t?.kind === 'ident' && t.value === 'not') {
      this.pos++;
      return !toBoolean(this.parseNot());
    }
    return this.parseComparison();
  }

  private parseComparison(): Value {
    const left = this.parsePrimary();
    const t = this.peek();
    if (t?.kind !== 'op') return left;
    this.pos++;
    const op = t.value;
    if (op === '=~' || op === '!~') {
      const rhs = this.tokens[this.pos];
      if (rhs?.kind !== 'regex' && rhs?.kind !== 'string') {
        throw new Error(`${op} expects a regex operand`);
      }
      this.pos++;
      const re = new RegExp(rhs.value);
      const matched = re.test(left === null ? '' : String(left));
      return op === '=~' ? matched : !matched;
    }
    const right = this.parsePrimary();
    const ln = toNumber(left);
    const rn = toNumber(right);
    const numeric = ln !== null && rn !== null;
    switch (op) {
      case '==':
      case '=':
        return numeric ? ln === rn : String(left) === String(right);
      case '!=':
        return numeric ? ln !== rn : String(left) !== String(right);
      case '<':
        if (!numeric) throw new Error('< needs numbers');
        return ln < rn;
      case '>':
        if (!numeric) throw new Error('> needs numbers');
        return ln > rn;
      case '<=':
        if (!numeric) throw new Error('<= needs numbers');
        return ln <= rn;
      case '>=':
        if (!numeric) throw new Error('>= needs numbers');
        return ln >= rn;
      default:
        throw new Error(`unsupported operator ${op}`);
    }
  }

  private parsePrimary(): Value {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of expression');
    if (t.kind === 'lparen') {
      this.pos++;
      const value = this.parseOr();
      if (this.peek()?.kind !== 'rparen') throw new Error('missing )');
      this.pos++;
      return value;
    }
    if (t.kind === 'number' || t.kind === 'string') {
      this.pos++;
      return t.value;
    }
    if (t.kind === 'regex') {
      this.pos++;
      return t.value;
    }
    if (t.kind === 'ident') {
      this.pos++;
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      let index: number | null = null;
      if (this.peek()?.kind === 'lbracket') {
        this.pos++;
        const idx = this.peek();
        if (idx?.kind !== 'number') throw new Error('expected an index');
        index = idx.value;
        this.pos++;
        if (this.peek()?.kind !== 'rbracket') throw new Error('missing ]');
        this.pos++;
      }
      const raw = this.lookup(t.value, index);
      if (raw === undefined || raw === null) return null;
      if (Array.isArray(raw)) return (raw[index ?? 0] ?? null) as Value;
      return raw as Value;
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`);
  }
}

/** Evaluate one condition against a resolved printer (or process) config. */
export function evaluateCondition(expression: string, lookup: ConfigLookup): ConditionResult {
  const trimmed = expression.trim();
  if (trimmed === '') return { value: true, evaluated: true };
  try {
    return { value: new Parser(tokenize(trimmed), lookup).parse(), evaluated: true };
  } catch (err) {
    // Permissive on failure: a preset we cannot classify stays visible and lands in the
    // report, rather than silently disappearing from the catalog.
    return { value: true, evaluated: false, error: (err as Error).message };
  }
}

/** Build a {@link ConfigLookup} over a resolved preset config. */
export function configLookup(config: Record<string, unknown>): ConfigLookup {
  return (key, index) => {
    const raw = config[key];
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) return raw[index ?? 0];
    return raw;
  };
}
