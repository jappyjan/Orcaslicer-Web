import { describe, expect, it } from 'vitest';

import {
  findSections,
  parseNumberExpression,
  parseStringExpression,
  splitStatements,
  stripComments,
  stripPreprocessor,
} from './cpp-source.js';
import {
  parseAxisDefaults,
  parseDefineConstants,
  parseEnumKeyMaps,
  parseMaterialTypes,
  parsePrintConfig,
  synthesizeMachineLimits,
  synthesizeOverrides,
} from './parse-print-config.js';

describe('cpp-source', () => {
  it('strips comments without moving byte offsets', () => {
    const src = 'a; // note\nb;\n/* block\nmore */ c;';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('note');
    expect(out).not.toContain('block');
    expect(out.trim().startsWith('a;')).toBe(true);
  });

  it('leaves punctuation inside string literals alone', () => {
    const src = 'def->tooltip = L("a; b { c } // d");';
    expect(stripComments(src)).toBe(src);
    const statements = splitStatements(stripComments(src), 0, src.length);
    expect(statements).toHaveLength(1);
  });

  it('blanks preprocessor directives so they do not glue onto the next statement', () => {
    const src = '#if FOO\n#endif\ndef = this->add("k", coBool);';
    const cleaned = stripPreprocessor(src);
    expect(cleaned.length).toBe(src.length);
    const statements = splitStatements(cleaned, 0, cleaned.length);
    expect(statements[0]?.text).toBe('def = this->add("k", coBool)');
  });

  it('attributes a constructor to its own class, not to a class missing its first letter', () => {
    const sections = findSections('CLIMiscConfigDef::CLIMiscConfigDef()\n{\n}\n');
    expect(sections[0]?.className).toBe('CLIMiscConfigDef');
    const withReturnType = findSections('void PrintConfigDef::init_fff_params()\n{\n}\n');
    expect(withReturnType[0]?.className).toBe('PrintConfigDef');
    expect(withReturnType[0]?.functionName).toBe('init_fff_params');
  });

  it('reads translation-wrapped, adjacent and utf-8 string literals', () => {
    expect(parseStringExpression('L("Layer height")')).toBe('Layer height');
    expect(parseStringExpression('L("a " "b")')).toBe('a b');
    expect(parseStringExpression('u8"°"')).toBe('°');
    expect(parseStringExpression('("%")')).toBe('%');
    expect(parseStringExpression('(boost::format("x %1%") % up).str()')).toBeNull();
  });

  it('reads numeric literals with C++ suffixes', () => {
    expect(parseNumberExpression('0.5f')).toBe(0.5);
    expect(parseNumberExpression('-3')).toBe(-3);
    expect(parseNumberExpression('max_temp')).toBeNull();
  });
});

const SAMPLE = `
static t_config_enum_values s_keys_map_BrimType = {
    {"no_brim",         btNoBrim},
    {"outer_only",      btOuterOnly},
};
CONFIG_OPTION_ENUM_DEFINE_STATIC_MAPS(BrimType)

#define INITIAL_LAYER_HEIGHT 0.2

void PrintConfigDef::init_fff_params()
{
    const int max_temp = 1500;

    def = this->add("layer_height", coFloat);
    def->label = L("Layer height");
    def->category = L("Quality");
    def->tooltip = L("Slicing height for each layer.");
    def->sidetext = L("mm");
    def->min = 0;
    def->set_default_value(new ConfigOptionFloat(0.2));

    def = this->add("nozzle_temperature", coInts);
    def->label = L("Nozzle temperature");
    def->sidetext = L(u8"\\u2103");
    def->min = 0;
    def->max = max_temp;
    def->mode = comExpert;
    def->set_default_value(new ConfigOptionInts { 200 });

    def = this->add("brim_type", coEnum);
    def->label = L("Brim type");
    def->enum_keys_map = &ConfigOptionEnum<BrimType>::get_enum_values();
    def->enum_values.emplace_back("no_brim");
    def->enum_values.emplace_back("outer_only");
    def->enum_labels.emplace_back(L("No-brim"));
    def->enum_labels.emplace_back(L("Outer brim only"));
    def->set_default_value(new ConfigOptionEnum<BrimType>(btOuterOnly));

    def = this->add("printable_area", coPoints);
    def->label = L("Printable area");
    def->set_default_value(new ConfigOptionPoints{ Vec2d(0, 0), Vec2d(200, 0), Vec2d(200, 200), Vec2d(0, 200) });

    def = this->add("retraction_length", coFloats);
    def->label = L("Length");
    def->sidetext = L("mm");
    def->set_default_value(new ConfigOptionFloats { 0.8 });
}
`;

describe('parsePrintConfig', () => {
  const parsed = parsePrintConfig(SAMPLE, {
    constants: parseDefineConstants('#define INITIAL_LAYER_HEIGHT 0.2\n'),
  });

  it('extracts label, category, tooltip, units, min and default', () => {
    const layerHeight = parsed.options.get('layer_height');
    expect(layerHeight).toMatchObject({
      key: 'layer_height',
      type: 'coFloat',
      valueKind: 'float',
      isArray: false,
      label: 'Layer height',
      category: 'Quality',
      units: 'mm',
      min: 0,
      default: 0.2,
      // No explicit def->mode: upstream's ConfigOptionDef default is comSimple.
      mode: 'simple',
    });
    expect(layerHeight?.tooltip).toContain('Slicing height');
  });

  it('resolves file-local constants and utf-8 units', () => {
    expect(parsed.options.get('nozzle_temperature')).toMatchObject({
      max: 1500,
      units: '℃',
      mode: 'expert',
      isArray: true,
      default: [200],
    });
  });

  it('pairs enum values with their human labels and resolves the enum default', () => {
    expect(parsed.options.get('brim_type')?.enumChoices).toEqual([
      { value: 'no_brim', label: 'No-brim' },
      { value: 'outer_only', label: 'Outer brim only' },
    ]);
    expect(parsed.options.get('brim_type')?.default).toBe('outer_only');
  });

  it('parses Vec2d point defaults without picking the digit out of "Vec2d"', () => {
    expect(parsed.options.get('printable_area')?.default).toEqual([
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
    ]);
  });

  it('reads the enum key maps', () => {
    expect(
      parseEnumKeyMaps(SAMPLE)
        .get('BrimType')
        ?.entries.map((e) => e.key),
    ).toEqual(['no_brim', 'outer_only']);
  });

  it('records nothing as an unexplained gap for a well-formed sample', () => {
    expect(parsed.gaps).toEqual([]);
  });
});

describe('synthesizeOverrides', () => {
  it('creates the nullable filament_* twin of an extruder option', () => {
    const parsed = parsePrintConfig(
      `${SAMPLE}\nconst std::vector<std::string> filament_extruder_override_keys = { "filament_retraction_length" };`,
    );
    const { added } = synthesizeOverrides(parsed);
    expect(added).toHaveLength(1);
    expect(parsed.options.get('filament_retraction_length')).toMatchObject({
      nullable: true,
      derivedFrom: 'retraction_length',
      label: 'Length',
      units: 'mm',
      default: [0.8],
      // Retraction length is one of the four keys upstream forces to comSimple.
      mode: 'simple',
    });
  });
});

const AXIS_SAMPLE = `
void PrintConfigDef::init_fff_params()
{
    {
        std::vector<AxisDefault> axes {
            { "x", { 500., 200. }, {  1000., 1000. }, { 10. , 10.  } },
            { "z", {  12.,  12. }, {   500.,  200. }, {  0.2,  0.4 } }
        };
        for (const AxisDefault &axis : axes) {
            def = this->add("machine_max_speed_" + axis.name, coFloats);
            def->full_label = (boost::format("Maximum speed %1%") % axis_upper).str();
            def->category = L("Machine limits");
            def->tooltip  = (boost::format("Maximum speed of %1% axis") % axis_upper).str();
            def->sidetext = L("mm/s");
            def->min = 0;
            def->mode = comSimple;
            def->set_default_value(new ConfigOptionFloats(axis.max_feedrate));
        }
    }
}
`;

describe('synthesizeMachineLimits', () => {
  it('expands the axis loop into real per-axis options with upstream defaults', () => {
    expect(parseAxisDefaults(AXIS_SAMPLE).map((a) => a.name)).toEqual(['x', 'z']);
    const parsed = parsePrintConfig(AXIS_SAMPLE);
    const { added } = synthesizeMachineLimits(AXIS_SAMPLE, parsed);
    expect(added.map((o) => o.key)).toEqual(['machine_max_speed_x', 'machine_max_speed_z']);
    expect(parsed.options.get('machine_max_speed_z')).toMatchObject({
      category: 'Machine limits',
      units: 'mm/s',
      min: 0,
      fullLabel: 'Maximum speed Z',
      tooltip: 'Maximum speed of Z axis',
      default: [12, 12],
    });
  });
});

describe('parseMaterialTypes', () => {
  it('reads the material name column', () => {
    const src = `const std::vector<MaterialTypeInfo>& MaterialType::all()
{
    static const std::vector<MaterialTypeInfo> material_types = {
        {"ABS",  190, 300},
        {"PLA",  190, 240},
    };
    return material_types;
}`;
    expect(parseMaterialTypes(src)).toEqual(['ABS', 'PLA']);
  });
});
