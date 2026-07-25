/**
 * Getting a mesh into the browser, and the three measurements the plater makes of it.
 *
 * Geometry is kept in the model's **own file coordinates** — not recentred, not dropped
 * to the bed. That is deliberate: the engine's `pos_x`/`pos_y`/`pos_z` are a translation
 * of exactly those coordinates (MEASURED, see `../state/plate.ts`), so keeping them means
 * the browser and the slicer are talking about the same numbers, and nothing has to
 * remember an extra offset that only one of the two applies.
 */

import {
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  MathUtils,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import type { Mesh as ThreeMesh, Object3D } from 'three';
import type { Box3Like, Instance } from '../state/plate.ts';
import { fetchModelFile } from '../api/plater.ts';

const cache = new Map<string, Promise<BufferGeometry>>();

/**
 * The geometry for a library model, fetched once per session.
 *
 * The response itself is `immutable`-cached by the browser (the id is a content hash), so
 * even a reload usually costs no network; this map exists so that ten copies of one model
 * on a plate share one `BufferGeometry` and one upload to the GPU.
 */
export function loadGeometry(modelId: string, filename: string): Promise<BufferGeometry> {
  const cached = cache.get(modelId);
  if (cached) return cached;
  const pending = fetchModelFile(modelId)
    .then((buffer) => parseGeometry(buffer, filename))
    .catch((error: unknown) => {
      cache.delete(modelId);
      throw error;
    });
  cache.set(modelId, pending);
  return pending;
}

export function resetGeometryCache(): void {
  cache.clear();
}

export class UnsupportedModelError extends Error {
  constructor(extension: string) {
    super(`${extension || 'This format'} cannot be shown on the plate yet`);
    this.name = 'UnsupportedModelError';
  }
}

export function parseGeometry(buffer: ArrayBuffer, filename: string): BufferGeometry {
  const extension = (/\.[^.]+$/.exec(filename.toLowerCase())?.[0] ?? '').trim();
  if (extension === '.stl') return new STLLoader().parse(buffer);
  if (extension === '.3mf') return flatten(new ThreeMFLoader().parse(buffer));
  // .obj/.step/.amf are accepted by the upload endpoint but cannot be transformed
  // server-side either; the plater says so instead of drawing nothing.
  throw new UnsupportedModelError(extension);
}

/**
 * A 3MF is a scene, not a mesh: merge its meshes into one geometry in the file's own
 * world coordinates, which is the same thing `readMesh` does server-side. Both sides
 * applying the build-item transforms is what keeps a rotated 3MF landing where it looked.
 */
function flatten(root: Object3D): BufferGeometry {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  root.traverse((node: Object3D) => {
    const mesh = node as ThreeMesh;
    const geometry = mesh.geometry as BufferGeometry | undefined;
    if (!geometry?.attributes?.position) return;
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const attribute = source.attributes.position;
    if (!attribute) return;
    const vertex = new Vector3();
    for (let index = 0; index < attribute.count; index += 1) {
      vertex.fromBufferAttribute(attribute, index).applyMatrix4(mesh.matrixWorld);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  });
  if (positions.length === 0) throw new Error('the 3MF contains no printable geometry');
  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return merged;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * The bounds of `matrix · vertices`, walked vertex by vertex.
 *
 * The cheap alternative — rotating the axis-aligned box and taking *its* bounds — is
 * wrong by up to 41 % on a diagonal, which for a 45°-turned part means the plater centres
 * it somewhere the slicer does not. This is O(vertices) and runs when a transform
 * changes, not per frame.
 */
export function measure(geometry: BufferGeometry, matrix: readonly number[]): Box3Like {
  const attribute = geometry.attributes.position;
  if (!attribute || attribute.count === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const [a, b, c, d, e, f, g, h, i] = matrix as number[];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < attribute.count; index += 1) {
    const x = attribute.getX(index);
    const y = attribute.getY(index);
    const z = attribute.getZ(index);
    const values: [number, number, number] = [
      (a as number) * x + (b as number) * y + (c as number) * z,
      (d as number) * x + (e as number) * y + (f as number) * z,
      (g as number) * x + (h as number) * y + (i as number) * z,
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      const value = values[axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  return { min, max };
}

/**
 * Lay flat: turn the model's largest flat face onto the bed.
 *
 * Area-weighted normals, bucketed by direction, largest bucket wins — which for anything
 * with a printable underside is the underside, and for a tilted import is the face the
 * user means. It is not a convex-hull placement (that is a desktop feature with a
 * face-picking gesture behind it, and picking a face with a thumb is exactly the
 * interaction hard constraint #5 says to cut), but it is honest about what it does.
 *
 * Returns the Euler XYZ, in degrees, that should replace the instance's rotation.
 */
export function layFlatRotation(
  geometry: BufferGeometry,
  instance: Pick<Instance, 'rotation' | 'scale'>,
  currentMatrix: readonly number[],
): [number, number, number] {
  const attribute = geometry.attributes.position;
  if (!attribute || attribute.count < 3) return instance.rotation;

  const linear = new Matrix4().set(
    currentMatrix[0] as number,
    currentMatrix[1] as number,
    currentMatrix[2] as number,
    0,
    currentMatrix[3] as number,
    currentMatrix[4] as number,
    currentMatrix[5] as number,
    0,
    currentMatrix[6] as number,
    currentMatrix[7] as number,
    currentMatrix[8] as number,
    0,
    0,
    0,
    0,
    1,
  );

  const buckets = new Map<string, { normal: Vector3; area: number }>();
  const p0 = new Vector3();
  const p1 = new Vector3();
  const p2 = new Vector3();
  const edge1 = new Vector3();
  const edge2 = new Vector3();
  const cross = new Vector3();

  for (let index = 0; index + 2 < attribute.count; index += 3) {
    p0.fromBufferAttribute(attribute, index).applyMatrix4(linear);
    p1.fromBufferAttribute(attribute, index + 1).applyMatrix4(linear);
    p2.fromBufferAttribute(attribute, index + 2).applyMatrix4(linear);
    edge1.subVectors(p1, p0);
    edge2.subVectors(p2, p0);
    cross.crossVectors(edge1, edge2);
    const area = cross.length() / 2;
    if (area <= 1e-9) continue;
    cross.divideScalar(area * 2);
    // ~6° buckets: fine enough to keep distinct faces apart, coarse enough that a
    // tessellated "flat" face made of not-quite-coplanar triangles still adds up.
    const key = [cross.x, cross.y, cross.z].map((value) => Math.round(value * 10)).join(',');
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.area += area;
      bucket.normal.addScaledVector(cross, area);
    } else {
      buckets.set(key, { normal: cross.clone().multiplyScalar(area), area });
    }
  }

  let best: { normal: Vector3; area: number } | undefined;
  for (const bucket of buckets.values()) {
    if (!best || bucket.area > best.area) best = bucket;
  }
  if (!best) return instance.rotation;

  const target = best.normal.normalize();
  // Rotate that normal to point straight down, then read the result back as Euler XYZ so
  // the rotate sliders still show something meaningful afterwards.
  const quaternion = new Quaternion().setFromUnitVectors(target, new Vector3(0, 0, -1));
  const current = new Quaternion().setFromEuler(
    new Euler(
      MathUtils.degToRad(instance.rotation[0]),
      MathUtils.degToRad(instance.rotation[1]),
      MathUtils.degToRad(instance.rotation[2]),
      'XYZ',
    ),
  );
  const euler = new Euler().setFromQuaternion(quaternion.multiply(current), 'XYZ');
  return [
    normaliseAngle(MathUtils.radToDeg(euler.x)),
    normaliseAngle(MathUtils.radToDeg(euler.y)),
    normaliseAngle(MathUtils.radToDeg(euler.z)),
  ];
}

function normaliseAngle(degrees: number): number {
  const rounded = Math.round(degrees * 100) / 100;
  if (rounded <= -180) return rounded + 360;
  if (rounded > 180) return rounded - 360;
  return rounded;
}
