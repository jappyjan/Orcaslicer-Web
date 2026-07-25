import { describe, expect, it } from 'vitest';
import type { EngineObject, EnginePlate } from '../port.js';
import { AssembleListError, buildAssembleList } from './assemble-list.js';

function object(overrides: Partial<EngineObject> = {}): EngineObject {
  return {
    path: '/work/j/models/1.stl',
    count: 1,
    filaments: [1],
    assembleIndex: [1],
    subtype: 'ModelPart',
    printParams: {},
    heightRanges: [],
    ...overrides,
  };
}

function plate(overrides: Partial<EnginePlate> = {}): EnginePlate {
  return { index: 1, name: 'plate_1', arrange: false, objects: [object()], ...overrides };
}

describe('buildAssembleList', () => {
  it('emits the shape the CLI expects', () => {
    const list = buildAssembleList([
      plate({ objects: [object({ posX: [120], posY: [120], posZ: [0] })] }),
    ]);
    expect(list).toEqual({
      plates: [
        {
          plate_index: 1,
          plate_name: 'plate_1',
          need_arrange: false,
          plate_params: {},
          objects: [
            {
              path: '/work/j/models/1.stl',
              count: 1,
              filaments: [1],
              assemble_index: [1],
              subtype: 'ModelPart',
              print_params: {},
              height_ranges: [],
              pos_x: [120],
              pos_y: [120],
              pos_z: [0],
            },
          ],
        },
      ],
    });
  });

  // SPEC: pos_x/pos_y are ONLY honoured when need_arrange is false. Emitting them
  // anyway would silently ignore the user's placement.
  it('refuses positions on an auto-arranged plate', () => {
    expect(() =>
      buildAssembleList([plate({ arrange: true, objects: [object({ posX: [10], posY: [10] })] })]),
    ).toThrow(AssembleListError);
  });

  it('omits positions entirely when the plate is auto-arranged', () => {
    const list = buildAssembleList([plate({ arrange: true })]);
    expect(list.plates[0]?.need_arrange).toBe(true);
    expect(list.plates[0]?.objects[0]).not.toHaveProperty('pos_x');
  });

  // SPEC: length must be 1 (applies to all copies) or equal to count.
  it('accepts a per-copy array of exactly `count` entries', () => {
    const list = buildAssembleList([
      plate({ objects: [object({ count: 3, filaments: [1, 2, 1], assembleIndex: [1, 1, 2] })] }),
    ]);
    expect(list.plates[0]?.objects[0]?.filaments).toEqual([1, 2, 1]);
  });

  it('rejects an array that is neither 1 nor count long', () => {
    expect(() =>
      buildAssembleList([plate({ objects: [object({ count: 3, filaments: [1, 2] })] })]),
    ).toThrow(/exactly 1 or 3/);
  });

  it('keeps a shared assemble_index so separate STLs compose into one object', () => {
    const list = buildAssembleList([
      plate({
        objects: [
          object({ path: '/work/j/models/a.stl', assembleIndex: [7] }),
          object({ path: '/work/j/models/b.stl', assembleIndex: [7] }),
        ],
      }),
    ]);
    expect(list.plates[0]?.objects.map((o) => o.assemble_index)).toEqual([[7], [7]]);
  });

  it('renames height ranges into the CLI spelling', () => {
    const list = buildAssembleList([
      plate({
        objects: [
          object({ heightRanges: [{ minZ: 0, maxZ: 4, rangeParams: { layer_height: 0.1 } }] }),
        ],
      }),
    ]);
    expect(list.plates[0]?.objects[0]?.height_ranges).toEqual([
      { min_z: 0, max_z: 4, range_params: { layer_height: 0.1 } },
    ]);
  });

  it('rejects empty plates and empty jobs', () => {
    expect(() => buildAssembleList([])).toThrow(AssembleListError);
    expect(() => buildAssembleList([plate({ objects: [] })])).toThrow(/no objects/);
  });
});
