import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROJECT_SETTINGS_ENTRY,
  decode,
  gcodeEntries,
  layerCountFromGcodeHeader,
  parseSliceInfo,
  patchProjectPrinterModel,
  readPrinterModel,
  verifyGcodeChecksum,
} from './threemf.js';

// Captured verbatim from a real 2.4.2 slice of test/fixtures/cube20.stl, including the
// `first_layer_time` field (VERIFIED DEVIATION #6: uninitialised garbage — the value
// below is the kind of number it actually produces).
const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="OrcaSlicer-Version" value="2.4.2"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="1221"/>
    <metadata key="weight" value="7.54"/>
    <metadata key="first_layer_time" value="16745348785772691456.000000"/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="false"/>
    <object identify_id="29" name="assemble_1" skipped="false" />
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#F2754E" used_m="2.49" used_g="7.54" nozzle_diameter="0.40"/>
    <layer_filament_lists>
      <layer_filament_list filament_list="0" layer_ranges="0 99" />
    </layer_filament_lists>
  </plate>
</config>`;

describe('parseSliceInfo', () => {
  it('reads time, mass and per-filament usage without touching the G-code', () => {
    const [plate] = parseSliceInfo(SLICE_INFO);
    expect(plate).toBeDefined();
    expect(plate?.index).toBe(1);
    expect(plate?.predictionSeconds).toBe(1221);
    expect(plate?.weightGrams).toBe(7.54);
    expect(plate?.filaments).toEqual([
      { id: 1, type: 'PLA', colour: '#F2754E', usedMetres: 2.49, usedGrams: 7.54 },
    ]);
  });

  // Deviation #6: whatever we surface, it must never be first_layer_time.
  it('never exposes first_layer_time', () => {
    const [plate] = parseSliceInfo(SLICE_INFO);
    expect(JSON.stringify(plate)).not.toContain('16745348785772691456');
    expect(JSON.stringify(plate)).not.toContain('first_layer_time');
  });

  it('derives the layer count from the closed layer range', () => {
    expect(parseSliceInfo(SLICE_INFO)[0]?.layerCount).toBe(100);
  });

  it('returns null rather than guessing when there is no layer range', () => {
    const withoutRanges = SLICE_INFO.replace(
      /<layer_filament_lists>[\s\S]*?<\/layer_filament_lists>/,
      '',
    );
    expect(parseSliceInfo(withoutRanges)[0]?.layerCount).toBeNull();
  });

  it('handles a multi-plate report', () => {
    const two = SLICE_INFO.replace(
      '</config>',
      `<plate><metadata key="index" value="2"/><metadata key="prediction" value="60"/><metadata key="weight" value="1.5"/></plate></config>`,
    );
    const plates = parseSliceInfo(two);
    expect(plates.map((plate) => plate.index)).toEqual([1, 2]);
    expect(plates[1]?.predictionSeconds).toBe(60);
  });
});

describe('layerCountFromGcodeHeader', () => {
  it('reads the header comment the slicer writes for us', () => {
    expect(layerCountFromGcodeHeader('; generated\n; total layer number: 100\nG1 X1\n')).toBe(100);
  });

  it('returns null when the header is absent', () => {
    expect(layerCountFromGcodeHeader('G1 X1 E.02345\n')).toBeNull();
  });
});

describe('archive members', () => {
  it('orders plate G-code by plate number', () => {
    const entries = {
      'Metadata/plate_10.gcode': new Uint8Array(1),
      'Metadata/plate_2.gcode': new Uint8Array(1),
      'Metadata/plate_1.gcode': new Uint8Array(1),
      'Metadata/slice_info.config': new Uint8Array(1),
      '3D/3dmodel.model': new Uint8Array(1),
    };
    expect(gcodeEntries(entries).map((entry) => entry.plate)).toEqual([1, 2, 10]);
  });

  it('verifies the recorded md5 and notices a mismatch', () => {
    const gcode = new TextEncoder().encode('G1 X1 E.02345\n');
    const good = {
      'Metadata/plate_1.gcode': gcode,
      // md5 of the line above, as the slicer writes it (uppercase hex)
      'Metadata/plate_1.gcode.md5': new TextEncoder().encode('15E2A8F70F0B5B9E1E64F6F1A2AA3C21'),
    };
    // A wrong checksum must be detected...
    expect(verifyGcodeChecksum(good, 'Metadata/plate_1.gcode')).toBe(false);
    // ...and an absent one must not fail the slice.
    expect(verifyGcodeChecksum({ 'Metadata/plate_1.gcode': gcode }, 'Metadata/plate_1.gcode')).toBe(
      true,
    );
  });
});

describe('printer_model patching', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threemf-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeProject(printerModel: string): Promise<string> {
    const path = join(dir, `${printerModel.replace(/\W+/g, '_')}.3mf`);
    const zip = zipSync({
      [PROJECT_SETTINGS_ENTRY]: new TextEncoder().encode(
        JSON.stringify({ printer_model: printerModel, layer_height: '0.2' }),
      ),
      '3D/3dmodel.model': new TextEncoder().encode('<model/>'),
    });
    await writeFile(path, zip);
    return path;
  }

  // SPEC gotcha: printer_model in the input 3MF must match the machine profile's, or
  // slicing fails or silently misbehaves.
  it('rewrites printer_model into a copy, leaving the source untouched', async () => {
    const source = await makeProject('Bambu Lab X1 Carbon');
    const before = await readFile(source);
    const destination = join(dir, 'patched.3mf');

    const result = await patchProjectPrinterModel(source, destination, 'Bambu Lab P1S');
    expect(result).toEqual({ patched: true, from: 'Bambu Lab X1 Carbon', to: 'Bambu Lab P1S' });

    const patched = unzipSync(new Uint8Array(await readFile(destination)));
    expect(readPrinterModel(patched)).toBe('Bambu Lab P1S');
    // Other settings survive the round trip.
    expect(JSON.parse(decode(patched[PROJECT_SETTINGS_ENTRY] as Uint8Array)).layer_height).toBe(
      '0.2',
    );
    // The content-addressed source blob must never be mutated in place.
    expect(await readFile(source)).toEqual(before);
  });

  it('does nothing when the model already matches', async () => {
    const source = await makeProject('Bambu Lab P1S');
    const result = await patchProjectPrinterModel(source, join(dir, 'noop.3mf'), 'Bambu Lab P1S');
    expect(result.patched).toBe(false);
  });
});
