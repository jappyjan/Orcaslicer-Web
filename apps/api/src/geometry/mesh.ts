/**
 * Reading a model file, transforming its triangles, and writing it back out as an STL.
 *
 * This exists for exactly one reason: **the engine's plate description carries positions
 * and nothing else.** `--load-assemble-list` has `pos_x`/`pos_y`/`pos_z` and no rotation
 * or scale fields, so an object the user has rotated or resized in the plater can only
 * reach the slicer with the transform already baked into its geometry. That happens here,
 * while the job's models are staged into its sandbox — above the engine boundary, because
 * "the geometry must already be in its final orientation" is a property of the plate
 * description, not of OrcaSlicer.
 *
 * The contract the plater depends on, stated once:
 *
 *     world vertex = transform · file vertex + pos
 *
 * `transform` is the 3×3 handed in here; `pos` is what the assemble list carries. The
 * client predicts positions with the same identity (apps/web/src/state/plate.ts), which
 * is what makes "slices to the exact positions shown on screen" testable.
 *
 * VERIFIED DEVIATION #11 (docs/SPEC.md): admesh's ASCII/binary sniffing wants a byte
 * greater than 127 within 128 bytes of offset 80, and a box with *zeroed* facet normals
 * does not have one at 10 mm or 15 mm — it loads at 19 mm and dies with
 * `CLI_DATA_FILE_ERROR` at 15 mm. {@link writeBinaryStl} therefore computes real unit
 * normals rather than writing zeros, which is cheap and makes the detection
 * deterministic at any size.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ModelTransform } from '@orca-web/shared';
import { unzipSync } from 'fflate';

/** Triangle soup: 9 floats per triangle (three xyz vertices), in file coordinates. */
export interface Mesh {
  positions: Float32Array;
  triangleCount: number;
}

export class MeshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshError';
  }
}

export const IDENTITY_TRANSFORM: ModelTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Within a micrometre per unit — a transform this close to identity changes nothing. */
export function isIdentityTransform(transform: readonly number[] | undefined): boolean {
  if (transform === undefined) return true;
  if (transform.length !== 9) return false;
  return transform.every(
    (value, index) => Math.abs(value - (IDENTITY_TRANSFORM[index] as number)) < 1e-6,
  );
}

export function assertTransform(transform: readonly number[]): ModelTransform {
  if (transform.length !== 9 || transform.some((value) => !Number.isFinite(value))) {
    throw new MeshError('a transform must be nine finite numbers (row-major 3x3)');
  }
  const [a, b, c, d, e, f, g, h, i] = transform as ModelTransform;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-9) {
    throw new MeshError('a transform must be invertible (a zero scale collapses the model)');
  }
  return transform as ModelTransform;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const BINARY_STL_HEADER = 84;
const BINARY_STL_FACET = 50;

/**
 * `nameHint` is the file name the *user* uploaded, which is where the format lives: the
 * library stores blobs content-addressed, so the path on disk is a bare hex digest with
 * no extension at all.
 */
export async function readMesh(path: string, nameHint = path): Promise<Mesh> {
  const data = await readFile(path);
  const extension = extname(nameHint).toLowerCase();
  if (extension === '.3mf') return read3mf(data);
  if (extension === '.stl') return readStl(data);
  throw new MeshError(
    `models in "${extension || 'unknown'}" format cannot be rotated or resized yet`,
  );
}

/**
 * Binary or ASCII STL.
 *
 * The format is decided by arithmetic, not by sniffing for a `solid` prefix: a binary
 * STL is exactly `84 + 50 · facets` bytes long, and plenty of binary files start with
 * the word `solid` because some exporter wrote it into the 80-byte header. (admesh's own
 * heuristic — a byte > 127 near offset 80 — is the one that misfires; see the file
 * header and SPEC deviation #11.)
 */
export function readStl(data: Uint8Array): Mesh {
  if (data.byteLength >= BINARY_STL_HEADER) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const facets = view.getUint32(80, true);
    if (data.byteLength === BINARY_STL_HEADER + facets * BINARY_STL_FACET && facets > 0) {
      const positions = new Float32Array(facets * 9);
      let offset = BINARY_STL_HEADER;
      for (let facet = 0; facet < facets; facet += 1) {
        offset += 12; // the stored normal is recomputed on write, never trusted on read
        for (let component = 0; component < 9; component += 1) {
          positions[facet * 9 + component] = view.getFloat32(offset, true);
          offset += 4;
        }
        offset += 2; // attribute byte count
      }
      return { positions, triangleCount: facets };
    }
  }
  return readAsciiStl(new TextDecoder().decode(data));
}

function readAsciiStl(text: string): Mesh {
  const numbers: number[] = [];
  const vertex = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let match = vertex.exec(text);
  while (match !== null) {
    numbers.push(Number(match[1]), Number(match[2]), Number(match[3]));
    match = vertex.exec(text);
  }
  if (numbers.length === 0 || numbers.length % 9 !== 0) {
    throw new MeshError('the file is neither a binary STL nor a parseable ASCII STL');
  }
  return { positions: Float32Array.from(numbers), triangleCount: numbers.length / 9 };
}

/**
 * The mesh of a 3MF, in the file's own world coordinates.
 *
 * `<build><item>` transforms are applied, and `<components>` are followed one level at a
 * time, so the result matches what a 3MF viewer (and the plater's `ThreeMFLoader`) shows.
 * Everything else in the format — materials, colours, per-slicer metadata — is ignored:
 * this function's only job is "which triangles, where".
 */
export function read3mf(data: Uint8Array): Mesh {
  const entries = unzipSync(data, { filter: (file) => /^3D\/.*\.model$/i.test(file.name) });
  const modelName = Object.keys(entries).find((name) => /^3D\/3dmodel\.model$/i.test(name));
  const model = modelName === undefined ? undefined : entries[modelName];
  if (model === undefined) throw new MeshError('the 3MF contains no 3D/3dmodel.model');
  return parse3mfModel(new TextDecoder().decode(model));
}

type Matrix4 = readonly number[]; // 12 numbers: 3x3 then translation, 3MF's own order

const IDENTITY_4: Matrix4 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMatrix(value: string | undefined): Matrix4 {
  if (value === undefined) return IDENTITY_4;
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.length === 12 && parts.every(Number.isFinite) ? parts : IDENTITY_4;
}

function multiply(outer: Matrix4, inner: Matrix4): Matrix4 {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += (inner[row * 3 + k] as number) * (outer[k * 3 + column] as number);
      }
      out.push(sum);
    }
  }
  for (let column = 0; column < 3; column += 1) {
    let sum = outer[9 + column] as number;
    for (let k = 0; k < 3; k += 1) {
      sum += (inner[9 + k] as number) * (outer[k * 3 + column] as number);
    }
    out.push(sum);
  }
  return out;
}

function attributesOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attribute = /([\w:.-]+)="([^"]*)"/g;
  let match = attribute.exec(tag);
  while (match !== null) {
    out[match[1] as string] = match[2] as string;
    match = attribute.exec(tag);
  }
  return out;
}

interface ParsedObject {
  vertices: number[];
  triangles: number[];
  components: Array<{ id: string; matrix: Matrix4 }>;
}

export function parse3mfModel(xml: string): Mesh {
  const objects = new Map<string, ParsedObject>();
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let match = objectRe.exec(xml);
  while (match !== null) {
    const id = attributesOf(match[1] as string).id;
    const body = match[2] as string;
    if (id !== undefined) objects.set(id, parseObject(body));
    match = objectRe.exec(xml);
  }

  const out: number[] = [];
  const emit = (id: string, matrix: Matrix4, depth: number): void => {
    if (depth > 8) return; // a component cycle is malformed input, not a stack overflow
    const object = objects.get(id);
    if (!object) return;
    for (const index of object.triangles) {
      const base = index * 3;
      const x = object.vertices[base] as number;
      const y = object.vertices[base + 1] as number;
      const z = object.vertices[base + 2] as number;
      out.push(
        x * (matrix[0] as number) +
          y * (matrix[3] as number) +
          z * (matrix[6] as number) +
          (matrix[9] as number),
        x * (matrix[1] as number) +
          y * (matrix[4] as number) +
          z * (matrix[7] as number) +
          (matrix[10] as number),
        x * (matrix[2] as number) +
          y * (matrix[5] as number) +
          z * (matrix[8] as number) +
          (matrix[11] as number),
      );
    }
    for (const component of object.components) {
      emit(component.id, multiply(matrix, component.matrix), depth + 1);
    }
  };

  const itemRe = /<item\b([^>]*)\/?>/g;
  let items = 0;
  match = itemRe.exec(xml);
  while (match !== null) {
    const attributes = attributesOf(match[1] as string);
    if (attributes.objectid !== undefined) {
      items += 1;
      emit(attributes.objectid, parseMatrix(attributes.transform), 0);
    }
    match = itemRe.exec(xml);
  }
  // A 3MF with no build items is legal but prints nothing; treat every object as placed
  // rather than returning an empty mesh the user cannot explain.
  if (items === 0) for (const id of objects.keys()) emit(id, IDENTITY_4, 0);

  if (out.length === 0 || out.length % 9 !== 0) {
    throw new MeshError('the 3MF contains no triangles');
  }
  return { positions: Float32Array.from(out), triangleCount: out.length / 9 };
}

function parseObject(body: string): ParsedObject {
  const vertices: number[] = [];
  const vertexRe = /<vertex\b([^>]*)\/?>/g;
  let match = vertexRe.exec(body);
  while (match !== null) {
    const attributes = attributesOf(match[1] as string);
    vertices.push(Number(attributes.x), Number(attributes.y), Number(attributes.z));
    match = vertexRe.exec(body);
  }

  const triangles: number[] = [];
  const triangleRe = /<triangle\b([^>]*)\/?>/g;
  match = triangleRe.exec(body);
  while (match !== null) {
    const attributes = attributesOf(match[1] as string);
    triangles.push(Number(attributes.v1), Number(attributes.v2), Number(attributes.v3));
    match = triangleRe.exec(body);
  }

  const components: Array<{ id: string; matrix: Matrix4 }> = [];
  const componentRe = /<component\b([^>]*)\/?>/g;
  match = componentRe.exec(body);
  while (match !== null) {
    const attributes = attributesOf(match[1] as string);
    if (attributes.objectid !== undefined) {
      components.push({ id: attributes.objectid, matrix: parseMatrix(attributes.transform) });
    }
    match = componentRe.exec(body);
  }

  return { vertices, triangles, components };
}

// ---------------------------------------------------------------------------
// Transforming and writing
// ---------------------------------------------------------------------------

/** `world = transform · vertex`, in place on a copy. Winding is flipped if the transform mirrors. */
export function transformMesh(mesh: Mesh, transform: ModelTransform): Mesh {
  const [a, b, c, d, e, f, g, h, i] = transform;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const source = mesh.positions;
  const positions = new Float32Array(source.length);
  for (let index = 0; index < source.length; index += 3) {
    const x = source[index] as number;
    const y = source[index + 1] as number;
    const z = source[index + 2] as number;
    positions[index] = a * x + b * y + c * z;
    positions[index + 1] = d * x + e * y + f * z;
    positions[index + 2] = g * x + h * y + i * z;
  }
  if (determinant < 0) {
    // A mirrored transform turns every triangle inside out; swapping two vertices puts
    // the winding — and therefore the normal the slicer computes — back the right way.
    for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
      const base = triangle * 9;
      for (let component = 0; component < 3; component += 1) {
        const first = positions[base + component] as number;
        positions[base + component] = positions[base + 3 + component] as number;
        positions[base + 3 + component] = first;
      }
    }
  }
  return { positions, triangleCount: mesh.triangleCount };
}

/**
 * A binary STL with real, normalised facet normals.
 *
 * The normals are not decoration — see SPEC deviation #11 and the file header. They are
 * also what every downstream consumer expects, so writing zeros would be wrong even if
 * admesh did not care.
 */
export function writeBinaryStl(mesh: Mesh, header = 'orcaslicer-web baked transform'): Buffer {
  const buffer = Buffer.alloc(BINARY_STL_HEADER + mesh.triangleCount * BINARY_STL_FACET);
  buffer.write(header.slice(0, 79), 0, 'ascii');
  buffer.writeUInt32LE(mesh.triangleCount, 80);

  let offset = BINARY_STL_HEADER;
  const p = mesh.positions;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    const base = triangle * 9;
    const ux = (p[base + 3] as number) - (p[base] as number);
    const uy = (p[base + 4] as number) - (p[base + 1] as number);
    const uz = (p[base + 5] as number) - (p[base + 2] as number);
    const vx = (p[base + 6] as number) - (p[base] as number);
    const vy = (p[base + 7] as number) - (p[base + 1] as number);
    const vz = (p[base + 8] as number) - (p[base + 2] as number);
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    buffer.writeFloatLE(nx, offset);
    buffer.writeFloatLE(ny, offset + 4);
    buffer.writeFloatLE(nz, offset + 8);
    offset += 12;
    for (let component = 0; component < 9; component += 1) {
      buffer.writeFloatLE(p[base + component] as number, offset);
      offset += 4;
    }
    offset += 2;
  }
  return buffer;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

export function boundsOf(mesh: Mesh): BoundingBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  return { min, max };
}

/**
 * Read `source`, apply `transform`, write a binary STL to `destination`.
 *
 * Returns the bounding box of the transformed geometry — the caller uses it to sanity
 * check what the client claimed it was placing.
 */
export async function bakeTransform(
  source: string,
  destination: string,
  transform: ModelTransform,
  nameHint?: string,
): Promise<BoundingBox> {
  const mesh = transformMesh(await readMesh(source, nameHint), assertTransform(transform));
  await writeFile(destination, writeBinaryStl(mesh));
  return boundsOf(mesh);
}
