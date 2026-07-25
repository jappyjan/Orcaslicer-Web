/**
 * The plate: what is on it, where, and what the engine will be told about it.
 *
 * This module is pure. It holds no three.js objects and touches no DOM — the scene
 * (`../three/plater-scene.ts`) renders what is described here, and never the other way
 * round. That split is what makes "the slice lands where the screen said" testable
 * without a browser.
 *
 * ## The one identity everything rests on
 *
 *     world vertex = matrix · file vertex + pos
 *
 * `matrix` is rotation ∘ scale, sent as `PlateObject.transform` and baked into the
 * geometry server-side (`apps/api/src/geometry/mesh.ts`); `pos` is `posX`/`posY`/`posZ`
 * in the engine's plate description. MEASURED against OrcaSlicer 2.4.2: `pos` is a plain
 * translation of the model's own file coordinates — *not* a placement of its centre — so
 * a 20 mm box whose STL spans 0…20 and is sent at `pos_x = 80` extrudes across x 80…100.
 *
 * An {@link Instance} is stated in the terms a person uses instead: `x`/`y` are where the
 * object's centre sits on the plate and `z` is how far its underside is above the bed.
 * {@link positionOf} converts, and it is the only place the two conventions meet.
 *
 * ## Why `box` is carried on the instance
 *
 * Every placement question — is it on the bed, does it touch its neighbour, where is its
 * underside — is a question about the *rotated and scaled* bounding box, and computing
 * that means walking the mesh. The scene does that once when the transform changes and
 * stores the answer here, so this module stays free of geometry and the UI stays free of
 * per-frame mesh walks. The box is deliberately the precise one: the bounding box of a
 * rotated mesh, not the rotated bounding box, which for a 45°-turned cylinder differs by
 * enough to place it visibly off target.
 */

import type { BedSpec, ModelTransform, PlateObject, PlateSpec } from '@orca-web/shared';

export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

/** One placed copy of a model. Copies are independent: duplicating gives a new instance. */
export interface Instance {
  /** Unique within the plate, and stable across edits — the scene keys meshes on it. */
  id: string;
  /** Content id in the model library. Several instances may share one. */
  modelId: string;
  filename: string;
  /** Centre of the object on the plate, mm. */
  x: number;
  y: number;
  /** Height of the object's underside above the bed, mm. 0 is "sitting on it". */
  z: number;
  /** Euler XYZ, degrees, in three.js's default order. */
  rotation: [number, number, number];
  /** Uniform, 1 = 100 %. */
  scale: number;
  /** Bounds of `matrix · fileVertices` — see the module header. */
  box: Box3Like;
}

export interface Plate {
  instances: Instance[];
  selectedId: string | null;
}

export const EMPTY_PLATE: Plate = { instances: [], selectedId: null };

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

/**
 * Rotation ∘ scale as a row-major 3×3.
 *
 * Euler XYZ in three.js's own convention, written out rather than imported: this module is
 * the one the job descriptor is built from, and keeping three.js out of it means the 600 kB
 * renderer is not on the path between opening the app and slicing. `plate.test.ts` asserts
 * agreement with `Matrix4.makeRotationFromEuler` to 12 decimal places, because two
 * definitions of "XYZ order" that differ would put the slice a fraction of a millimetre
 * from the picture and nothing would say why.
 */
export function matrixOf(instance: Pick<Instance, 'rotation' | 'scale'>): ModelTransform {
  const [x, y, z] = instance.rotation.map(toRadians) as [number, number, number];
  const a = Math.cos(x);
  const b = Math.sin(x);
  const c = Math.cos(y);
  const d = Math.sin(y);
  const e = Math.cos(z);
  const f = Math.sin(z);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  const s = instance.scale;
  // `+ 0` turns -0 into 0. Cosmetic, but a matrix printed with negative zeros in it looks
  // like a bug to the next person reading a job descriptor.
  return [
    c * e * s + 0,
    -c * f * s + 0,
    d * s + 0,
    (af + be * d) * s + 0,
    (ae - bf * d) * s + 0,
    -b * c * s + 0,
    (bf - ae * d) * s + 0,
    (be + af * d) * s + 0,
    a * c * s + 0,
  ];
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isIdentityMatrix(matrix: readonly number[]): boolean {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return matrix.every((value, index) => Math.abs(value - (identity[index] as number)) < 1e-9);
}

/** Row-major 3×3 product, `outer · inner`. */
function multiply3(outer: readonly number[], inner: readonly number[]): number[] {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += (outer[row * 3 + k] as number) * (inner[k * 3 + column] as number);
      }
      out.push(sum);
    }
  }
  return out;
}

/** The inverse of {@link matrixOf} for a pure rotation: three.js's XYZ extraction. */
export function eulerOf(matrix: readonly number[]): [number, number, number] {
  const m11 = matrix[0] as number;
  const m12 = matrix[1] as number;
  const m13 = matrix[2] as number;
  const m22 = matrix[4] as number;
  const m23 = matrix[5] as number;
  const m32 = matrix[7] as number;
  const m33 = matrix[8] as number;
  const y = Math.asin(clamp(m13, -1, 1));
  // Gimbal lock: with the model turned a quarter turn about Y, X and Z describe the same
  // rotation and only their sum is defined. three.js resolves it by pinning Z at 0.
  const locked = Math.abs(m13) >= 0.9999999;
  const x = locked ? Math.atan2(m32, m22) : Math.atan2(-m23, m33);
  const z = locked ? 0 : Math.atan2(-m12, m11);
  return [round2(toDegrees(x)), round2(toDegrees(y)), round2(toDegrees(z))];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The instance's own rotation with another one applied on top of it.
 *
 * Used for auto-arrange: the engine answers with `rotation · vertex + position`, and it is
 * free to turn an object as well as move it. Because an instance's transform is a rotation
 * composed with a *uniform* scale, `arranged · rotation · scale` is still a rotation
 * composed with the same scale — so the result is representable, and the rotate sliders
 * keep showing something meaningful afterwards instead of quietly disagreeing with the
 * mesh on screen.
 */
export function composedRotation(
  applied: readonly number[],
  instance: Pick<Instance, 'rotation'>,
): [number, number, number] {
  return eulerOf(multiply3(applied, matrixOf({ rotation: instance.rotation, scale: 1 })));
}

/** `pos` for the engine: the translation that puts the transformed mesh where the user put it. */
export function positionOf(instance: Instance): [number, number, number] {
  const { box } = instance;
  return [
    instance.x - (box.min[0] + box.max[0]) / 2,
    instance.y - (box.min[1] + box.max[1]) / 2,
    instance.z - box.min[2],
  ];
}

/** Where the object actually sits on the plate, in bed coordinates. */
export function worldBox(instance: Instance): Box3Like {
  const [dx, dy, dz] = positionOf(instance);
  return {
    min: [instance.box.min[0] + dx, instance.box.min[1] + dy, instance.box.min[2] + dz],
    max: [instance.box.max[0] + dx, instance.box.max[1] + dy, instance.box.max[2] + dz],
  };
}

export function sizeOf(instance: Instance): [number, number, number] {
  return [
    instance.box.max[0] - instance.box.min[0],
    instance.box.max[1] - instance.box.min[1],
    instance.box.max[2] - instance.box.min[2],
  ];
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

let counter = 0;

export function newInstanceId(): string {
  counter += 1;
  return `i${counter}`;
}

export function bedCentre(bed: BedSpec | null): [number, number] {
  if (!bed || bed.printableArea.length === 0) return [0, 0];
  const xs = bed.printableArea.map((point) => point[0]);
  const ys = bed.printableArea.map((point) => point[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export function updateInstance(
  plate: Plate,
  id: string,
  change: Partial<Instance> | ((instance: Instance) => Partial<Instance>),
): Plate {
  return {
    ...plate,
    instances: plate.instances.map((instance) =>
      instance.id === id
        ? { ...instance, ...(typeof change === 'function' ? change(instance) : change) }
        : instance,
    ),
  };
}

export function removeInstance(plate: Plate, id: string): Plate {
  const instances = plate.instances.filter((instance) => instance.id !== id);
  return {
    instances,
    selectedId: plate.selectedId === id ? (instances[0]?.id ?? null) : plate.selectedId,
  };
}

/**
 * A copy, offset far enough to be visibly a second object.
 *
 * Deliberately not placed *exactly* on top of the original: a duplicate you cannot see
 * reads as "nothing happened", and the engine would reject the plate for a collision.
 */
export function duplicateInstance(plate: Plate, id: string): Plate {
  const source = plate.instances.find((instance) => instance.id === id);
  if (!source) return plate;
  const [width] = sizeOf(source);
  const copy: Instance = {
    ...source,
    id: newInstanceId(),
    // Clear of the original by 5 mm, which is also enough for the engine's own
    // object-collision check (exit -64) to be satisfied.
    x: source.x + width + 5,
  };
  return { instances: [...plate.instances, copy], selectedId: copy.id };
}

/** Put the underside back on the bed. `z` is the only thing that can lift an object. */
export function dropToBed(plate: Plate, id: string): Plate {
  return updateInstance(plate, id, { z: 0 });
}

// ---------------------------------------------------------------------------
// Fit: the feedback the engine would otherwise give as an exit code
// ---------------------------------------------------------------------------

export type FitProblem = 'outside' | 'collision' | 'too-tall';

/**
 * What the engine would refuse to slice, shown before it is asked.
 *
 * The engine's answers are exit codes: `-52` `CLI_OBJECTS_PARTLY_INSIDE`, `-64`
 * `CLI_OBJECT_COLLISION_IN_LAYER_PRINT`, and (MEASURED) `-100` for an object left
 * floating above the bed. Finding out a minute into a slice that two objects overlap is a
 * bad enough experience on a desktop; on a phone, on mobile data, it is the difference
 * between using this and not.
 *
 * Bounding boxes, not convex hulls: conservative in the direction that matters — it warns
 * about a few plates the engine would have accepted, and never stays quiet about one it
 * would reject.
 */
export function fitProblems(
  instances: readonly Instance[],
  bed: BedSpec | null,
): Map<string, FitProblem> {
  const problems = new Map<string, FitProblem>();
  if (!bed || bed.printableArea.length === 0) return problems;

  const xs = bed.printableArea.map((point) => point[0]);
  const ys = bed.printableArea.map((point) => point[1]);
  const bounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
  const exclude = boxOfPolygon(bed.excludeArea);
  const boxes = instances.map((instance) => ({ id: instance.id, box: worldBox(instance) }));

  for (const { id, box } of boxes) {
    if (
      box.min[0] < bounds.minX ||
      box.max[0] > bounds.maxX ||
      box.min[1] < bounds.minY ||
      box.max[1] > bounds.maxY ||
      (exclude !== null && overlaps2d(box, exclude))
    ) {
      problems.set(id, 'outside');
      continue;
    }
    if (bed.printableHeight > 0 && box.max[2] > bed.printableHeight) {
      problems.set(id, 'too-tall');
    }
  }

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i] as { id: string; box: Box3Like };
      const b = boxes[j] as { id: string; box: Box3Like };
      if (!overlaps2d(a.box, b.box)) continue;
      if (!problems.has(a.id)) problems.set(a.id, 'collision');
      if (!problems.has(b.id)) problems.set(b.id, 'collision');
    }
  }
  return problems;
}

function boxOfPolygon(points: readonly [number, number][]): Box3Like | null {
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    min: [Math.min(...xs), Math.min(...ys), -Infinity],
    max: [Math.max(...xs), Math.max(...ys), Infinity],
  };
}

/** A shared edge is not an overlap; a 0.01 mm interpenetration is. */
function overlaps2d(a: Box3Like, b: Box3Like): boolean {
  const epsilon = 1e-3;
  return (
    a.min[0] < b.max[0] - epsilon &&
    a.max[0] > b.min[0] + epsilon &&
    a.min[1] < b.max[1] - epsilon &&
    a.max[1] > b.min[1] + epsilon
  );
}

export function describeProblem(problem: FitProblem): string {
  switch (problem) {
    case 'outside':
      return 'Off the plate';
    case 'collision':
      return 'Overlapping';
    case 'too-tall':
      return 'Too tall for this printer';
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * The plate, as the engine's plate description.
 *
 * `arrange` is **false** and every object carries a real `posX`/`posY`/`posZ`: positions
 * are ignored otherwise (SPEC — `pos_x`/`pos_y` are only honoured when `need_arrange` is
 * false), which is exactly the trap that would make the plater look like it worked while
 * the engine quietly re-packed the plate.
 *
 * One entry per instance, each with its own `assembleIndex`. Objects that *share* an
 * assemble index are merged into one composed model (SPEC), which is the multi-part hook
 * — not what two separately placed copies mean.
 */
export function toPlateSpec(instances: readonly Instance[]): PlateSpec {
  return {
    index: 1,
    arrange: false,
    objects: instances.map((instance, index): PlateObject => {
      const [posX, posY, posZ] = positionOf(instance);
      const matrix = matrixOf(instance);
      const object: PlateObject = {
        model: { source: 'library', id: instance.modelId },
        count: 1,
        filaments: [1],
        assembleIndex: [index + 1],
        posX: [round(posX)],
        posY: [round(posY)],
        posZ: [round(posZ)],
      };
      // Identity is omitted rather than sent: it is the difference between the library
      // blob being hard-linked into the sandbox and being re-exported through a mesh
      // transform, and the overwhelming majority of plates never rotate anything.
      if (!isIdentityMatrix(matrix)) object.transform = matrix;
      return object;
    }),
  };
}

/** Micrometre resolution. Printers do not have more, and it keeps the JSON readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
