/**
 * Idiom-aware parser for OrcaSlicer's `src/libslic3r/PrintConfig.cpp`.
 *
 * Upstream declares every option with the same builder idiom:
 *
 * ```cpp
 * def = this->add("layer_height", coFloat);
 * def->label    = L("Layer height");
 * def->category = L("Quality");
 * def->tooltip  = L("Slicing height for each layer…");
 * def->sidetext = L("mm");
 * def->min      = 0;
 * def->mode     = comAdvanced;
 * def->set_default_value(new ConfigOptionFloat(0.2));
 * ```
 *
 * so the parser walks statements and folds `def->…` assignments into the option most
 * recently `add`ed. Deviations it is deliberately taught about:
 *
 *  - `auto alias = def = this->add(…)` and later `def->enum_values = alias->enum_values;`
 *  - `def->enum_values.push_back("k")` / `.emplace_back("k")` paired with `enum_labels`
 *  - `def->enum_keys_map = &s_keys_map_X` / `&ConfigOptionEnum<X>::get_enum_values()`
 *  - the `filament_extruder_override_keys` loop, which synthesises ~16 `filament_*`
 *    options by copying the matching extruder option (handled in {@link synthesizeOverrides})
 *
 * Anything it does not understand is recorded as a {@link SchemaGap} and counted, never
 * dropped silently: an extractor that quietly loses options is worse than one that says so.
 */

import type {
  ConfigOptionSchema,
  DisclosureMode,
  EnumChoice,
  SchemaGap,
  ValueKind,
} from '@orca-web/catalog';
import {
  findSections,
  LineIndex,
  parseNumberExpression,
  parseStringExpression,
  splitArguments,
  splitStatements,
  stripComments,
  type SourceSection,
} from './cpp-source.js';

/** `PrintConfigDef` members that actually declare preset options. */
const PRESET_SECTIONS = new Set([
  'init_common_params',
  'init_fff_params',
  'init_sla_params',
  'PrintConfigDef',
]);

const CLI_CLASSES = new Set(['CLIActionsConfigDef', 'CLITransformConfigDef', 'CLIMiscConfigDef']);

const MODE_MAP: Record<string, DisclosureMode> = {
  comSimple: 'simple',
  comAdvanced: 'advanced',
  comExpert: 'expert',
  comDevelop: 'develop',
};

const VALUE_KIND: Record<string, ValueKind> = {
  coFloat: 'float',
  coFloats: 'float',
  coInt: 'int',
  coInts: 'int',
  coString: 'string',
  coStrings: 'string',
  coPercent: 'percent',
  coPercents: 'percent',
  coFloatOrPercent: 'floatOrPercent',
  coFloatsOrPercents: 'floatOrPercent',
  coPoint: 'point',
  coPoints: 'points',
  coPoint3: 'point',
  coBool: 'bool',
  coBools: 'bool',
  coEnum: 'enum',
  coEnums: 'enum',
  coNone: 'unknown',
};

const ARRAY_TYPES = new Set([
  'coFloats',
  'coInts',
  'coStrings',
  'coPercents',
  'coFloatsOrPercents',
  'coPoints',
  'coBools',
  'coEnums',
]);

/** Facts the parser needs that live in headers next to `PrintConfig.cpp`. */
export interface ParseContext {
  /**
   * `#define NAME value` macros from `PrintConfigConstants.hpp`. A few defaults are
   * written as macros (`new ConfigOptionFloat(INITIAL_LAYER_HEIGHT)`).
   */
  constants?: Map<string, string>;
  /**
   * Material names from `MaterialType::all()` (`MaterialType.cpp`). Upstream fills
   * `filament_type`'s dropdown from them in a `for` loop, so the literal values are
   * not in `PrintConfig.cpp` at all.
   */
  materialTypes?: string[];
}

/** Parse `#define NAME value` lines out of a header. */
export function parseDefineConstants(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*#define\s+([A-Za-z_]\w*)\s+([^\r\n/]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.set(m[1] as string, (m[2] as string).trim());
  return out;
}

/**
 * Collect file-local numeric constants (`const int max_temp = 1500;`) and string
 * variables (`std::string point_tooltip = L("…");`) that option definitions refer to.
 */
export function parseLocalConstants(cleaned: string): Map<string, string> {
  const out = new Map<string, string>();
  const numeric = /\b(?:const\s+)?(?:int|double|float|size_t|unsigned)\s+(\w+)\s*=\s*([^;{]+);/g;
  let m: RegExpExecArray | null;
  while ((m = numeric.exec(cleaned)) !== null) {
    const value = (m[2] as string).trim();
    if (parseNumberExpression(value) !== null && !out.has(m[1] as string)) {
      out.set(m[1] as string, value);
    }
  }
  const strings =
    /\b(?:const\s+)?(?:std::string|auto)\s+(\w+)\s*=\s*((?:_?_?u8L|_L|L|_)?\s*\((?:[^()]|\([^()]*\))*\)|"(?:[^"\\]|\\.)*")\s*;/g;
  while ((m = strings.exec(cleaned)) !== null) {
    if (parseStringExpression(m[2] as string) !== null && !out.has(m[1] as string)) {
      out.set(m[1] as string, m[2] as string);
    }
  }
  return out;
}

/** Parse the material names out of `MaterialType::all()`'s table. */
export function parseMaterialTypes(source: string): string[] {
  const table = /MaterialType::all\(\)[\s\S]*?\{([\s\S]*?)\n\s*\};/.exec(source);
  if (!table) return [];
  const names: string[] = [];
  const re = /\{\s*"((?:[^"\\]|\\.)*)"\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(table[1] as string)) !== null) names.push(m[1] as string);
  return names;
}

export interface EnumKeyMap {
  /** e.g. `BedType` for `s_keys_map_BedType`. */
  name: string;
  /** Ordered `{ "string key" -> C++ constant expression }` pairs as written upstream. */
  entries: { key: string; constant: string }[];
}

export interface ParsedPrintConfig {
  /** `PrintConfigDef` options — preset keys, also accepted as `--flags` by the CLI. */
  options: Map<string, ConfigOptionSchema>;
  /** `CLI*ConfigDef` options — command-line-only flags. */
  cliOptions: Map<string, ConfigOptionSchema>;
  /** Placeholder-parser variables for custom G-code (read-only, not preset keys). */
  placeholderOptions: Map<string, ConfigOptionSchema>;
  enumKeyMaps: Map<string, EnumKeyMap>;
  gaps: SchemaGap[];
  /** `this->add(...)` calls seen inside `PrintConfigDef`, including ones we failed to parse. */
  addCallsInPrintConfigDef: number;
  /** Keys listed in `filament_extruder_override_keys`. */
  overrideKeys: string[];
}

function newOption(key: string, type: string, section: string, line: number): ConfigOptionSchema {
  return {
    key,
    type,
    valueKind: VALUE_KIND[type] ?? 'unknown',
    isArray: ARRAY_TYPES.has(type),
    nullable: false,
    // Upstream default: `ConfigOptionMode mode = comSimple;` (src/libslic3r/Config.hpp).
    mode: 'simple',
    default: null,
    section,
    sourceLine: line,
  };
}

/** Parse the `static t_config_enum_values s_keys_map_X { {"k", V}, … };` tables. */
export function parseEnumKeyMaps(cleaned: string): Map<string, EnumKeyMap> {
  const maps = new Map<string, EnumKeyMap>();
  const re = /t_config_enum_values\s+s_keys_map_(\w+)\s*=?\s*\{([\s\S]*?)\n\s*\};/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1] as string;
    const body = m[2] as string;
    const entries: { key: string; constant: string }[] = [];
    const entryRe = /\{\s*("(?:[^"\\]|\\.)*")\s*,\s*([^},]+?)\s*\}/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(body)) !== null) {
      const key = parseStringExpression(e[1] as string);
      if (key === null) continue;
      entries.push({ key, constant: (e[2] as string).trim() });
    }
    maps.set(name, { name, entries });
  }
  return maps;
}

/** `s_keys_map_BedType` / `ConfigOptionEnum<BedType>::get_enum_values()` → `BedType`. */
function enumTypeFromKeysMapExpression(expr: string): string | null {
  const direct = /s_keys_map_(\w+)/.exec(expr);
  if (direct) return direct[1] as string;
  const templated = /ConfigOptionEnum(?:sGeneric)?<\s*(\w+)\s*>/.exec(expr);
  if (templated) return templated[1] as string;
  return null;
}

/**
 * Reverse an enum table: C++ constant expression → string key. Registers several
 * spellings because upstream writes `btPC`, `int(BrimType::Painted)` and
 * `BrimType::Painted` interchangeably.
 */
function reverseEnumMap(map: EnumKeyMap): Map<string, string> {
  const rev = new Map<string, string>();
  for (const { key, constant } of map.entries) {
    const normalised = constant.replace(/\s+/g, '');
    const candidates = new Set<string>([normalised]);
    const unwrapped = /^(?:int|static_cast<int>)\((.*)\)$/.exec(normalised);
    if (unwrapped) candidates.add(unwrapped[1] as string);
    for (const c of [...candidates]) {
      const tail = c.split('::').pop();
      if (tail) candidates.add(tail);
    }
    for (const c of candidates) if (!rev.has(c)) rev.set(c, key);
  }
  return rev;
}

interface DefaultParseResult {
  value: unknown;
  evaluated: boolean;
}

/** Evaluate `new ConfigOptionXxx(...)` / `new ConfigOptionXxx{...}` into a JSON value. */
function parseDefaultValue(
  expr: string,
  option: ConfigOptionSchema,
  enumKeyMaps: Map<string, EnumKeyMap>,
  enumTypeOf: Map<string, string>,
  constants: Map<string, string>,
): DefaultParseResult {
  const m = /^new\s+(\w+)\s*(?:<\s*(\w+)\s*>)?\s*([({])([\s\S]*)[)}]$/.exec(expr.trim());
  if (!m) return { value: null, evaluated: false };
  const ctor = m[1] as string;
  const templateArg = m[2];
  // `new ConfigOptionFloats({0})` — a braced initialiser inside the call parentheses.
  let argText = (m[4] as string).trim();
  if (argText.startsWith('{') && argText.endsWith('}')) argText = argText.slice(1, -1).trim();

  // `new ConfigOptionFloats()` / `new ConfigOptionString()` — an empty default.
  if (argText === '') {
    if (option.isArray) return { value: [], evaluated: true };
    if (option.valueKind === 'string') return { value: '', evaluated: true };
    if (option.valueKind === 'bool') return { value: false, evaluated: true };
    if (option.valueKind === 'int' || option.valueKind === 'float')
      return { value: 0, evaluated: true };
    return { value: null, evaluated: true };
  }

  // `new ConfigOptionFloatsNullable{ ConfigOptionFloatsNullable::nil_value() }` —
  // an explicitly "unset" nullable default.
  if (/^\w+::nil_value\(\)$/.test(argText)) {
    return { value: option.isArray ? [null] : null, evaluated: true };
  }

  const args = splitArguments(argText).filter((a) => a !== '');

  const scalar = (raw: string): DefaultParseResult => {
    const a = constants.get(raw.trim()) ?? raw;
    const s = parseStringExpression(a);
    if (s !== null) return { value: s, evaluated: true };
    if (/^true$/.test(a.trim())) return { value: true, evaluated: true };
    if (/^false$/.test(a.trim())) return { value: false, evaluated: true };
    const n = parseNumberExpression(a);
    if (n !== null) return { value: n, evaluated: true };
    return { value: null, evaluated: false };
  };

  // Enum defaults resolve through the option's own key map.
  if (ctor.startsWith('ConfigOptionEnum')) {
    const enumType = templateArg ?? enumTypeOf.get(option.key);
    const map = enumType ? enumKeyMaps.get(enumType) : undefined;
    if (map) {
      const rev = reverseEnumMap(map);
      const values = args
        .map((a) => {
          // `(int)Overhang_threshold_bridge`, `int(BrimType::Painted)`, `btPC`
          const token = a.replace(/\s+/g, '').replace(/^\((?:int|unsigned|size_t)\)/, '');
          return rev.get(token) ?? rev.get(token.split('::').pop() ?? token);
        })
        .filter((v): v is string => v !== undefined);
      if (values.length === args.length && values.length > 0) {
        return option.isArray || ctor.includes('Enums')
          ? { value: values, evaluated: true }
          : { value: values[0], evaluated: true };
      }
    }
    return { value: null, evaluated: false };
  }

  if (
    ctor.startsWith('ConfigOptionFloatOrPercent') ||
    ctor.startsWith('ConfigOptionFloatsOrPercents')
  ) {
    // `ConfigOptionFloatOrPercent(value, isPercent)`
    const value = parseNumberExpression(args[0] ?? '');
    const percent = (args[1] ?? '').trim();
    if (value !== null && (percent === 'true' || percent === 'false')) {
      return { value: percent === 'true' ? `${value}%` : value, evaluated: true };
    }
    return { value: null, evaluated: false };
  }

  if (ctor.startsWith('ConfigOptionPoint')) {
    // `Vec2d(0, 0), Vec2d(200, 0), …` — matching bare numbers would pick the `2` out
    // of `Vec2d`, which is how a bed ends up 2x0 mm.
    const points: number[][] = [];
    const vecRe = /Vec[23]d\s*\(([^)]*)\)/g;
    let v: RegExpExecArray | null;
    while ((v = vecRe.exec(argText)) !== null) {
      const nums = splitArguments(v[1] as string)
        .map((a) => parseNumberExpression(a))
        .filter((n): n is number => n !== null);
      if (nums.length >= 2) points.push(nums);
    }
    if (points.length === 0) return { value: null, evaluated: false };
    return option.isArray
      ? { value: points, evaluated: true }
      : { value: points[0] as number[], evaluated: true };
  }

  if (option.isArray || /s(?:Nullable)?$/.test(ctor)) {
    const parsed = args.map(scalar);
    if (parsed.every((p) => p.evaluated)) {
      return { value: parsed.map((p) => p.value), evaluated: true };
    }
    return { value: null, evaluated: false };
  }

  if (args.length === 1) return scalar(args[0] as string);
  return { value: null, evaluated: false };
}

/**
 * Parse `PrintConfig.cpp`.
 *
 * @param source raw file contents of the pinned tag.
 */
export function parsePrintConfig(source: string, context: ParseContext = {}): ParsedPrintConfig {
  const cleaned = stripComments(source);
  const lines = new LineIndex(cleaned);
  const enumKeyMaps = parseEnumKeyMaps(cleaned);
  // File-local constants first, then the pinned-header ones (which win on conflict).
  const constants = new Map<string, string>([
    ...parseLocalConstants(cleaned),
    ...(context.constants ?? new Map<string, string>()),
  ]);
  const materialTypes = context.materialTypes ?? [];

  const options = new Map<string, ConfigOptionSchema>();
  const cliOptions = new Map<string, ConfigOptionSchema>();
  const placeholderOptions = new Map<string, ConfigOptionSchema>();
  const gaps: SchemaGap[] = [];
  const enumTypeOf = new Map<string, string>();
  /** enum_values / enum_labels accumulated per option key before they are zipped. */
  const enumValues = new Map<string, string[]>();
  const enumLabels = new Map<string, string[]>();
  /** `auto alias = def = this->add(...)` — alias name → option key. */
  const aliases = new Map<string, string>();
  let addCallsInPrintConfigDef = 0;

  const sections = findSections(cleaned).filter(
    (s) =>
      s.className === 'PrintConfigDef' ||
      CLI_CLASSES.has(s.className) ||
      s.className.endsWith('ConfigDef'),
  );

  const targetFor = (
    section: SourceSection,
  ): { map: Map<string, ConfigOptionSchema>; counts: boolean } | null => {
    if (section.className === 'PrintConfigDef') {
      return PRESET_SECTIONS.has(section.functionName) ? { map: options, counts: true } : null;
    }
    if (CLI_CLASSES.has(section.className)) return { map: cliOptions, counts: false };
    return { map: placeholderOptions, counts: false };
  };

  for (const section of sections) {
    const target = targetFor(section);
    if (!target) continue;
    const sectionName =
      section.className === 'PrintConfigDef' ? section.functionName : section.className;
    let current: ConfigOptionSchema | null = null;

    for (const st of splitStatements(cleaned, section.bodyStart, section.bodyEnd)) {
      const line = lines.lineAt(st.offset);
      const addMatch =
        /^(?:(?:auto|ConfigOptionDef\s*\*)\s+(\w+)\s*=\s*)?def\s*=\s*this->(add|add_nullable)\s*\(([\s\S]*)\)$/.exec(
          st.text,
        );
      if (addMatch) {
        if (target.counts) addCallsInPrintConfigDef++;
        const args = splitArguments(addMatch[3] as string);
        const key = parseStringExpression(args[0] ?? '');
        const type = (args[1] ?? '').trim();
        if (key === null) {
          // e.g. the `filament_extruder_override_keys` loop, whose key is a loop variable.
          gaps.push({
            kind: 'unparsed-add-call',
            detail: `non-literal option key in \`${st.text.slice(0, 120)}\``,
            sourceLine: line,
          });
          current = null;
          continue;
        }
        if (target.map.has(key)) {
          // Upstream redefines a handful of keys; the last definition wins in libslic3r
          // too (`options[key] = def`), so match that but say so.
          gaps.push({
            kind: 'unparsed-add-call',
            key,
            detail: `option redefined; the later definition (line ${line}) wins, as it does upstream`,
            sourceLine: line,
          });
        }
        const option = newOption(key, type, sectionName, line);
        option.nullable = addMatch[2] === 'add_nullable';
        if (!(type in VALUE_KIND)) {
          gaps.push({
            kind: 'unparsed-add-call',
            key,
            detail: `unknown option type token \`${type}\``,
            sourceLine: line,
          });
        }
        target.map.set(key, option);
        current = option;
        if (addMatch[1]) aliases.set(addMatch[1] as string, key);
        continue;
      }

      if (!current) continue;

      // `def->enum_values.push_back("x")` / `.emplace_back(L("X"))`
      const pushMatch =
        /^def->(enum_values|enum_labels)\.(?:push_back|emplace_back)\s*\(([\s\S]*)\)$/.exec(
          st.text,
        );
      if (pushMatch) {
        const value = parseStringExpression(pushMatch[2] as string);
        if (value === null) {
          // `for (const auto& filament : MaterialType::all()) def->enum_values.push_back(filament.name);`
          // — the only computed enum list upstream has, filled from the pinned MaterialType.cpp.
          if (
            current.key === 'filament_type' &&
            pushMatch[1] === 'enum_values' &&
            materialTypes.length > 0
          ) {
            enumValues.set(current.key, [...materialTypes]);
            continue;
          }
          gaps.push({
            kind: 'unparsed-assignment',
            key: current.key,
            detail: `non-literal ${pushMatch[1]} entry: ${st.text.slice(0, 120)}`,
            sourceLine: line,
          });
          continue;
        }
        const bucket = pushMatch[1] === 'enum_values' ? enumValues : enumLabels;
        const list = bucket.get(current.key) ?? [];
        list.push(value);
        bucket.set(current.key, list);
        continue;
      }

      const assign = /^def->(\w+)\s*=\s*([\s\S]*)$/.exec(st.text);
      if (assign) {
        applyAssignment(current, assign[1] as string, assign[2] as string, line);
        continue;
      }

      const setDefault = /^def->set_default_value\s*\(([\s\S]*)\)$/.exec(st.text);
      if (setDefault) {
        const result = parseDefaultValue(
          setDefault[1] as string,
          current,
          enumKeyMaps,
          enumTypeOf,
          constants,
        );
        current.default = result.value;
        if (!result.evaluated) {
          current.defaultExpression = (setDefault[1] as string).trim();
          gaps.push({
            kind: 'unevaluated-default',
            key: current.key,
            detail: `default expression not evaluated: ${current.defaultExpression.slice(0, 160)}`,
            sourceLine: line,
          });
        }
        continue;
      }

      if (/^def->set_enum_labels\s*\(/.test(st.text)) {
        gaps.push({
          kind: 'unparsed-assignment',
          key: current.key,
          detail: `unhandled set_enum_labels call: ${st.text.slice(0, 120)}`,
          sourceLine: line,
        });
      }
    }
  }

  function applyAssignment(
    option: ConfigOptionSchema,
    field: string,
    rawValue: string,
    line: number,
  ): void {
    const value = rawValue.trim();

    // `def->sidetext = def_infill_anchor_min->sidetext;` — copy a field from an aliased
    // definition. Upstream uses this to keep sibling options in lockstep.
    const aliasCopy = /^(\w+)->(\w+)$/.exec(value);
    if (aliasCopy && field !== 'enum_values' && field !== 'enum_labels') {
      const sourceKey = aliases.get(aliasCopy[1] as string);
      const source = sourceKey ? options.get(sourceKey) : undefined;
      if (source && aliasCopy[2] === field) {
        const mapped: Record<string, keyof ConfigOptionSchema> = {
          label: 'label',
          full_label: 'fullLabel',
          tooltip: 'tooltip',
          category: 'category',
          sidetext: 'units',
          gui_type: 'guiType',
          gui_flags: 'guiFlags',
          min: 'min',
          max: 'max',
          max_literal: 'maxLiteral',
          mode: 'mode',
        };
        const prop = mapped[field];
        if (prop && source[prop] !== undefined) {
          (option as unknown as Record<string, unknown>)[prop] = source[prop];
          return;
        }
      }
    }

    switch (field) {
      case 'label':
      case 'full_label':
      case 'tooltip':
      case 'category':
      case 'sidetext':
      case 'gui_type':
      case 'gui_flags': {
        // `def->gui_type = ConfigOptionDef::GUIType::select_open;` — an enum, not a string.
        const guiEnum = /^ConfigOptionDef::GUIType::(\w+)$/.exec(value);
        if (field === 'gui_type' && guiEnum) {
          option.guiType = guiEnum[1] as string;
          return;
        }
        const s = parseStringExpression(value) ?? parseStringExpression(constants.get(value) ?? '');
        if (s === null) {
          gaps.push({
            kind: 'unparsed-assignment',
            key: option.key,
            detail: `non-literal ${field}: ${value.slice(0, 120)}`,
            sourceLine: line,
          });
          return;
        }
        if (field === 'label') option.label = s;
        else if (field === 'full_label') option.fullLabel = s;
        else if (field === 'tooltip') option.tooltip = s;
        else if (field === 'category') option.category = s;
        else if (field === 'sidetext') option.units = s;
        else if (field === 'gui_type') option.guiType = s;
        else option.guiFlags = s;
        return;
      }
      case 'min':
      case 'max':
      case 'max_literal': {
        // `def->min = -max_temp;` — a negated file-local constant.
        const negated = value.startsWith('-') ? value.slice(1).trim() : null;
        const substituted =
          constants.get(value) ??
          (negated && constants.has(negated) ? `-${constants.get(negated)}` : value);
        const n = parseNumberExpression(substituted);
        if (n === null) {
          gaps.push({
            kind: 'unparsed-assignment',
            key: option.key,
            detail: `non-numeric ${field}: ${value.slice(0, 120)}`,
            sourceLine: line,
          });
          return;
        }
        if (field === 'min') option.min = n;
        else if (field === 'max') option.max = n;
        else option.maxLiteral = n;
        return;
      }
      case 'mode': {
        const mapped = MODE_MAP[value];
        if (!mapped) {
          gaps.push({
            kind: 'unparsed-assignment',
            key: option.key,
            detail: `unknown mode \`${value}\``,
            sourceLine: line,
          });
          return;
        }
        option.mode = mapped;
        return;
      }
      case 'multiline':
      case 'readonly':
      case 'nullable': {
        const b = value === 'true';
        if (field === 'multiline') option.multiline = b;
        else if (field === 'readonly') option.readOnly = b;
        else option.nullable = b;
        return;
      }
      case 'enum_keys_map': {
        const enumType = enumTypeFromKeysMapExpression(value);
        if (!enumType || !enumKeyMaps.has(enumType)) {
          gaps.push({
            kind: 'unknown-enum-keys-map',
            key: option.key,
            detail: `cannot resolve enum key map from \`${value.slice(0, 120)}\``,
            sourceLine: line,
          });
          return;
        }
        enumTypeOf.set(option.key, enumType);
        return;
      }
      case 'enum_values':
      case 'enum_labels': {
        // `def->enum_values = def_top_fill_pattern->enum_values;`
        const copy = /^(\w+)->(enum_values|enum_labels)$/.exec(value);
        const sourceKey = copy ? aliases.get(copy[1] as string) : undefined;
        if (!sourceKey) {
          gaps.push({
            kind: 'unparsed-assignment',
            key: option.key,
            detail: `cannot resolve ${field} source \`${value.slice(0, 120)}\``,
            sourceLine: line,
          });
          return;
        }
        const bucket = field === 'enum_values' ? enumValues : enumLabels;
        bucket.set(option.key, [...(bucket.get(sourceKey) ?? [])]);
        if (!enumTypeOf.has(option.key) && enumTypeOf.has(sourceKey)) {
          enumTypeOf.set(option.key, enumTypeOf.get(sourceKey) as string);
        }
        return;
      }
      default:
        // cli, cli_params, aliases, shortcut, ratio_over, height/width, … — upstream
        // fields the schema deliberately does not model.
        return;
    }
  }

  // Zip enum values with their labels; fall back to the enum key map when upstream
  // set only `enum_keys_map` (the UI then shows every key of the enum).
  const allOptions = [...options.values(), ...cliOptions.values(), ...placeholderOptions.values()];
  for (const option of allOptions) {
    const values = enumValues.get(option.key);
    const labels = enumLabels.get(option.key);
    if (values && values.length > 0) {
      if (labels && labels.length !== values.length) {
        gaps.push({
          kind: 'enum-values-labels-mismatch',
          key: option.key,
          detail: `${values.length} enum_values vs ${labels.length} enum_labels; labels padded with values`,
          sourceLine: option.sourceLine,
        });
      }
      option.enumChoices = values.map((value, i): EnumChoice => ({
        value,
        label: labels?.[i] ?? value,
      }));
    } else if (option.valueKind === 'enum') {
      const enumType = enumTypeOf.get(option.key);
      const map = enumType ? enumKeyMaps.get(enumType) : undefined;
      if (map) {
        option.enumChoices = map.entries.map(({ key }): EnumChoice => ({ value: key, label: key }));
      } else {
        gaps.push({
          kind: 'unknown-enum-keys-map',
          key: option.key,
          detail: 'enum option has neither enum_values nor a resolvable enum key map',
          sourceLine: option.sourceLine,
        });
      }
    }
  }

  return {
    options,
    cliOptions,
    placeholderOptions,
    enumKeyMaps,
    gaps,
    addCallsInPrintConfigDef,
    overrideKeys: parseOverrideKeys(cleaned),
  };
}

/** Read the `filament_extruder_override_keys` vector literal. */
export function parseOverrideKeys(cleaned: string): string[] {
  const m = /filament_extruder_override_keys\s*=\s*\{([\s\S]*?)\}\s*;/.exec(cleaned);
  if (!m) return [];
  const keys: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let e: RegExpExecArray | null;
  while ((e = re.exec(m[1] as string)) !== null) keys.push(e[1] as string);
  return keys;
}

interface AxisDefault {
  name: string;
  max_feedrate: number[];
  max_acceleration: number[];
  max_jerk: number[];
}

/** Read the `std::vector<AxisDefault> axes { { "x", {…}, {…}, {…} }, … }` table. */
export function parseAxisDefaults(cleaned: string): AxisDefault[] {
  const table = /std::vector<AxisDefault>\s+axes\s*\{([\s\S]*?)\n\s*\};/.exec(cleaned);
  if (!table) return [];
  const axes: AxisDefault[] = [];
  const rowRe = /\{\s*"(\w+)"\s*,\s*\{([^}]*)\}\s*,\s*\{([^}]*)\}\s*,\s*\{([^}]*)\}\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(table[1] as string)) !== null) {
    const nums = (s: string) =>
      splitArguments(s)
        .map((a) => parseNumberExpression(a))
        .filter((n): n is number => n !== null);
    axes.push({
      name: m[1] as string,
      max_feedrate: nums(m[2] as string),
      max_acceleration: nums(m[3] as string),
      max_jerk: nums(m[4] as string),
    });
  }
  return axes;
}

/**
 * Reproduce upstream's `for (const AxisDefault &axis : axes)` loop, which defines the
 * twelve `machine_max_{speed,acceleration,jerk}_{x,y,z,e}` keys — real machine-preset
 * keys (every Bambu machine profile sets them), so dropping them is not an option.
 *
 * The loop concatenates the axis name into the key and builds labels with
 * `boost::format("… %1%") % axis_upper`, so the statement walker cannot see the keys.
 * Both the axis table and the per-axis defaults are read from the source, not hardcoded.
 */
export function synthesizeMachineLimits(
  source: string,
  parsed: ParsedPrintConfig,
): { added: ConfigOptionSchema[]; gaps: SchemaGap[] } {
  const cleaned = stripComments(source);
  const axes = parseAxisDefaults(cleaned);
  const added: ConfigOptionSchema[] = [];
  const gaps: SchemaGap[] = [];
  if (axes.length === 0) {
    gaps.push({
      kind: 'unparsed-add-call',
      detail: 'machine limits: could not read the AxisDefault table',
      sourceLine: 0,
    });
    return { added, gaps };
  }

  const lines = new LineIndex(cleaned);
  const groups: {
    keyPrefix: string;
    defaultField: keyof AxisDefault;
    fullLabelFormat?: string;
    tooltipFormat?: string;
    category?: string;
    units?: string;
    min?: number;
    mode: DisclosureMode;
    sourceLine: number;
  }[] = [];

  // Walk the loop body statement by statement, attributing `def->…` to the last
  // `def = this->add("machine_max_<kind>_" + axis.name, coFloats)` seen.
  const loopStart = cleaned.indexOf('for (const AxisDefault &axis : axes)');
  if (loopStart === -1) {
    gaps.push({
      kind: 'unparsed-add-call',
      detail: 'machine limits: could not find the axis loop',
      sourceLine: 0,
    });
    return { added, gaps };
  }
  const loopEnd = cleaned.indexOf('\n    }', loopStart);
  for (const st of splitStatements(cleaned, loopStart, loopEnd === -1 ? cleaned.length : loopEnd)) {
    const add = /^def\s*=\s*this->add\(\s*"(machine_max_\w+_)"\s*\+\s*axis\.name\s*,/.exec(st.text);
    if (add) {
      groups.push({
        keyPrefix: add[1] as string,
        defaultField: 'max_feedrate',
        mode: 'simple',
        sourceLine: lines.lineAt(st.offset),
      });
      continue;
    }
    const group = groups[groups.length - 1];
    if (!group) continue;
    const fmt = /^def->(full_label|tooltip)\s*=\s*\(boost::format\("([^"]*)"\)/.exec(st.text);
    if (fmt) {
      if (fmt[1] === 'full_label') group.fullLabelFormat = fmt[2] as string;
      else group.tooltipFormat = fmt[2] as string;
      continue;
    }
    const assign = /^def->(\w+)\s*=\s*([\s\S]*)$/.exec(st.text);
    if (assign) {
      const field = assign[1] as string;
      const value = (assign[2] as string).trim();
      if (field === 'category') {
        const s = parseStringExpression(value);
        if (s !== null) group.category = s;
      } else if (field === 'sidetext') {
        const s = parseStringExpression(value);
        if (s !== null) group.units = s;
      } else if (field === 'min') {
        const n = parseNumberExpression(value);
        if (n !== null) group.min = n;
      } else if (field === 'mode') group.mode = MODE_MAP[value] ?? 'simple';
      continue;
    }
    const def = /^def->set_default_value\(\s*new\s+ConfigOptionFloats\(axis\.(\w+)\)\s*\)$/.exec(
      st.text,
    );
    if (def) group.defaultField = def[1] as keyof AxisDefault;
  }

  for (const group of groups) {
    for (const axis of axes) {
      const upper = axis.name.toUpperCase();
      const key = `${group.keyPrefix}${axis.name}`;
      const option: ConfigOptionSchema = {
        key,
        type: 'coFloats',
        valueKind: 'float',
        isArray: true,
        nullable: false,
        mode: group.mode,
        default: group.defaultField === 'name' ? null : (axis[group.defaultField] as number[]),
        section: 'init_fff_params (machine limits axis loop)',
        sourceLine: group.sourceLine,
      };
      if (group.fullLabelFormat) {
        option.fullLabel = group.fullLabelFormat.replace('%1%', upper);
        option.label = option.fullLabel;
      }
      if (group.tooltipFormat) option.tooltip = group.tooltipFormat.replace('%1%', upper);
      if (group.category) option.category = group.category;
      if (group.units) option.units = group.units;
      if (group.min !== undefined) option.min = group.min;
      parsed.options.set(key, option);
      added.push(option);
    }
  }
  return { added, gaps };
}

/**
 * Reproduce upstream's `for (auto& opt_key : filament_extruder_override_keys)` loop.
 *
 * The loop creates a nullable `filament_<x>` twin of the extruder option `<x>`, copying
 * label/tooltip/units/enum/min/max, and forcing the disclosure level: four retraction
 * keys are `comSimple`, everything else `comAdvanced`. Mirrored here because the loop's
 * option keys are runtime values, so the statement parser cannot see them.
 */
export function synthesizeOverrides(parsed: ParsedPrintConfig): {
  added: ConfigOptionSchema[];
  gaps: SchemaGap[];
} {
  const SIMPLE_MODE_KEYS = new Set([
    'filament_retraction_length',
    'filament_z_hop',
    'filament_long_retractions_when_cut',
    'filament_retraction_distances_when_cut',
  ]);
  const added: ConfigOptionSchema[] = [];
  const gaps: SchemaGap[] = [];
  for (const key of parsed.overrideKeys) {
    const baseKey = key.replace(/^filament_/, '');
    const base = parsed.options.get(baseKey);
    if (!base) {
      gaps.push({
        kind: 'unparsed-add-call',
        key,
        detail: `filament_extruder_override_keys entry has no base option \`${baseKey}\``,
        sourceLine: 0,
      });
      continue;
    }
    const option: ConfigOptionSchema = {
      ...base,
      key,
      nullable: true,
      mode: SIMPLE_MODE_KEYS.has(key) ? 'simple' : 'advanced',
      derivedFrom: baseKey,
      // Upstream copies the base default into the nullable variant verbatim.
      default: base.default,
      section: 'init_fff_params (filament_extruder_override_keys)',
    };
    if (base.enumChoices) option.enumChoices = base.enumChoices.map((c) => ({ ...c }));
    parsed.options.set(key, option);
    added.push(option);
  }
  return { added, gaps };
}
