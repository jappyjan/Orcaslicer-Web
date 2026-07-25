/**
 * The plate's maths, which is the whole milestone: *"a two-object plate arranged entirely
 * on a phone slices to the exact positions shown on screen."*
 *
 * Two of these tests are load-bearing beyond their file:
 *
 *  - the Euler agreement test, because `plate.ts` writes out three.js's XYZ convention by
 *    hand so the renderer stays out of the app's critical path. If the two ever diverge,
 *    the screen and the slice diverge with them.
 *  - the serialisation tests, because `posX`/`posY` are silently ignored unless
 *    `need_arrange` is false (SPEC), which is a failure mode with no error message.
 *
 * The end-to-end proof — that these numbers come back out of the G-code — is
 * `test/e2e/plater.mjs`, which slices for real and parses the extrusions.
 */

import { Euler, MathUtils, Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import type { BedSpec } from '@orca-web/shared';
import {
  composedRotation,
  duplicateInstance,
  eulerOf,
  fitProblems,
  matrixOf,
  positionOf,
  removeInstance,
  toPlateSpec,
  updateInstance,
  worldBox,
  type Instance,
  type Plate,
} from './plate.ts';

/** A 20 mm box whose STL spans 0…20 in every axis — the shape M0's fixture actually is. */
function box(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'a',
    modelId: 'sha256:abc',
    filename: 'cube20.stl',
    x: 128,
    y: 128,
    z: 0,
    rotation: [0, 0, 0],
    scale: 1,
    box: { min: [0, 0, 0], max: [20, 20, 20] },
    ...overrides,
  };
}

const BED: BedSpec = {
  printerModel: 'Bambu Lab X1 Carbon',
  preset: { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' },
  printableArea: [
    [0, 0],
    [256, 0],
    [256, 256],
    [0, 256],
  ],
  printableHeight: 250,
  excludeArea: [
    [0, 0],
    [18, 0],
    [18, 28],
    [0, 28],
  ],
  extruderOffset: [0, 2],
};

describe('the transform', () => {
  it('agrees with three.js about Euler XYZ, to twelve places', () => {
    // The reason this file may not simply import three.js: `plate.ts` is on the path from
    // opening the app to submitting a slice, and three is 600 kB. Writing the convention
    // out is only safe if it is checked against the original.
    for (const rotation of [
      [0, 0, 0],
      [90, 0, 0],
      [0, 90, 0],
      [0, 0, 90],
      [12, -34, 56],
      [-179.5, 44.25, 100.75],
      [33, 90, 12],
    ] as Array<[number, number, number]>) {
      const mine = matrixOf({ rotation, scale: 1 });
      const theirs = new Matrix4().makeRotationFromEuler(
        new Euler(
          MathUtils.degToRad(rotation[0]),
          MathUtils.degToRad(rotation[1]),
          MathUtils.degToRad(rotation[2]),
          'XYZ',
        ),
      ).elements;
      // three's elements are column-major; ours is row-major.
      const expected = [
        theirs[0],
        theirs[4],
        theirs[8],
        theirs[1],
        theirs[5],
        theirs[9],
        theirs[2],
        theirs[6],
        theirs[10],
      ];
      for (const [index, value] of mine.entries()) {
        expect(value).toBeCloseTo(expected[index] as number, 12);
      }
    }
  });

  it('agrees with three.js about reading an Euler back out', () => {
    for (const rotation of [
      [0, 0, 0],
      [12, -34, 56],
      [0, 90, 0],
    ] as Array<[number, number, number]>) {
      const matrix = matrixOf({ rotation, scale: 1 });
      const theirs = new Euler().setFromRotationMatrix(
        new Matrix4().set(
          matrix[0],
          matrix[1],
          matrix[2],
          0,
          matrix[3],
          matrix[4],
          matrix[5],
          0,
          matrix[6],
          matrix[7],
          matrix[8],
          0,
          0,
          0,
          0,
          1,
        ),
        'XYZ',
      );
      const mine = eulerOf(matrix);
      expect(mine[0]).toBeCloseTo(MathUtils.radToDeg(theirs.x), 6);
      expect(mine[1]).toBeCloseTo(MathUtils.radToDeg(theirs.y), 6);
      expect(mine[2]).toBeCloseTo(MathUtils.radToDeg(theirs.z), 6);
    }
  });

  it('scales uniformly', () => {
    expect(matrixOf({ rotation: [0, 0, 0], scale: 2 })).toEqual([2, 0, 0, 0, 2, 0, 0, 0, 2]);
  });

  it('composes an arrange rotation onto the instance’s own', () => {
    const composed = composedRotation(matrixOf({ rotation: [0, 0, 90], scale: 1 }), {
      rotation: [0, 0, 45],
    });
    expect(composed[2]).toBeCloseTo(135, 6);
  });
});

describe('placement', () => {
  it('translates the file’s own coordinates, not the object’s centre', () => {
    // MEASURED against 2.4.2: a cube whose STL spans 0…20, sent at pos_x = 80, extrudes
    // across x 80…100. So placing its *centre* at 128 means pos = 118, not 128. Getting
    // this backwards offsets every object by half its size — plausibly, and silently.
    expect(positionOf(box())).toEqual([118, 118, 0]);
  });

  it('puts the underside on the bed unless it is lifted', () => {
    expect(positionOf(box({ box: { min: [0, 0, 5], max: [20, 20, 25] } }))[2]).toBe(-5);
    expect(positionOf(box({ z: 3, box: { min: [0, 0, 5], max: [20, 20, 25] } }))[2]).toBe(-2);
  });

  it('reports where the object actually sits', () => {
    expect(worldBox(box())).toEqual({ min: [118, 118, 0], max: [138, 138, 20] });
  });
});

describe('fit', () => {
  it('is quiet about a plate the engine would accept', () => {
    expect(fitProblems([box(), box({ id: 'b', x: 60, y: 60 })], BED).size).toBe(0);
  });

  it('catches an object hanging off the plate — the engine’s exit -52', () => {
    expect(fitProblems([box({ x: 252 })], BED).get('a')).toBe('outside');
    expect(fitProblems([box({ x: -1 })], BED).get('a')).toBe('outside');
  });

  it('catches an object standing on the excluded area', () => {
    // The nozzle-wipe pad in the front-left corner of a Bambu plate.
    expect(fitProblems([box({ x: 12, y: 12 })], BED).get('a')).toBe('outside');
  });

  it('catches overlapping objects — the engine’s exit -64', () => {
    const problems = fitProblems([box(), box({ id: 'b', x: 138, y: 128 })], BED);
    expect(problems.get('a')).toBe('collision');
    expect(problems.get('b')).toBe('collision');
  });

  it('allows objects that merely touch', () => {
    expect(fitProblems([box(), box({ id: 'b', x: 148, y: 128 })], BED).size).toBe(0);
  });

  it('catches an object taller than the printer', () => {
    const tall = box({ box: { min: [0, 0, 0], max: [20, 20, 300] } });
    expect(fitProblems([tall], BED).get('a')).toBe('too-tall');
  });

  it('says nothing at all without a bed', () => {
    // No bed means no plater and no positions; the descriptor falls back to letting the
    // engine arrange. Inventing a default plate to check against would be worse than
    // silence, because it would be confidently wrong for every printer but one.
    expect(fitProblems([box({ x: 9999 })], null).size).toBe(0);
  });
});

describe('editing', () => {
  const plate: Plate = { instances: [box()], selectedId: 'a' };

  it('duplicates to a place you can see', () => {
    const next = duplicateInstance(plate, 'a');
    expect(next.instances).toHaveLength(2);
    expect(next.selectedId).toBe(next.instances[1]?.id);
    // Not on top of the original: an invisible duplicate reads as "nothing happened", and
    // the engine would reject the plate for a collision.
    expect(fitProblems(next.instances, BED).size).toBe(0);
  });

  it('selects a neighbour when the selected object is deleted', () => {
    const two = duplicateInstance(plate, 'a');
    const next = removeInstance(two, two.selectedId as string);
    expect(next.instances).toHaveLength(1);
    expect(next.selectedId).toBe('a');
  });

  it('updates one instance and leaves the rest alone', () => {
    const two = duplicateInstance(plate, 'a');
    const next = updateInstance(two, 'a', { x: 40 });
    expect(next.instances[0]?.x).toBe(40);
    expect(next.instances[1]?.x).toBe(two.instances[1]?.x);
  });
});

describe('serialisation', () => {
  it('sends explicit positions with arrange off', () => {
    // SPEC: pos_x/pos_y are ONLY honoured when need_arrange is false. Sending both would
    // look right and re-pack the plate anyway, with no error anywhere.
    const spec = toPlateSpec([box(), box({ id: 'b', x: 60, y: 60 })]);
    expect(spec.arrange).toBe(false);
    expect(spec.index).toBe(1);
    expect(spec.objects).toHaveLength(2);
    expect(spec.objects[0]?.posX).toEqual([118]);
    expect(spec.objects[1]?.posX).toEqual([50]);
    expect(spec.objects[0]?.posZ).toEqual([0]);
  });

  it('gives every instance its own assemble index', () => {
    // Objects sharing an assemble_index are MERGED into one composed model (SPEC). Two
    // separately placed copies are two objects.
    const spec = toPlateSpec([box(), box({ id: 'b', x: 60 })]);
    expect(spec.objects.map((object) => object.assembleIndex)).toEqual([[1], [2]]);
    expect(spec.objects.every((object) => object.count === 1)).toBe(true);
  });

  it('omits an identity transform and sends a real one', () => {
    const [plain] = toPlateSpec([box()]).objects;
    expect(plain?.transform).toBeUndefined();

    const [turned] = toPlateSpec([box({ rotation: [0, 0, 90] })]).objects;
    expect(turned?.transform).toBeDefined();
    expect(turned?.transform?.[0]).toBeCloseTo(0, 12);
    expect(turned?.transform?.[1]).toBeCloseTo(-1, 12);
  });

  it('rounds to a micrometre', () => {
    const [object] = toPlateSpec([box({ x: 128.00049 })]).objects;
    expect(object?.posX).toEqual([118]);
  });
});
