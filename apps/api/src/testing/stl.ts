/**
 * A minimal binary-STL writer, used only by tests that need several *distinct* models.
 *
 * The model library is content-addressed, so slicing "three models" that happen to be
 * byte-identical would exercise one blob and one hash. Generating boxes of different
 * sizes gives three genuinely different inputs with three different layer counts.
 *
 * NOTE — facet normals are written for real, and they have to be. libslic3r inherits
 * admesh's ASCII/binary sniffing: it reads 128 bytes starting at offset 80 and only
 * calls the file binary if one of them exceeds 127. A box with zeroed normals and
 * small coordinates has no such byte (10.0f and 15.0f encode as 00 00 20 41 and
 * 00 00 70 41), so the loader treats it as ASCII and the slice dies with
 * CLI_DATA_FILE_ERROR — while the same box at 19 mm or 20 mm loads fine. Unit normals
 * put a 0x3F/0x80 in every facet and make the detection deterministic.
 */

type Vec3 = readonly [number, number, number];

const FACES: ReadonlyArray<readonly [Vec3, Vec3, Vec3]> = [
  // -Z
  [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ],
  [
    [0, 0, 0],
    [1, 1, 0],
    [1, 0, 0],
  ],
  // +Z
  [
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  [
    [0, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ],
  // -Y
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
  ],
  [
    [0, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ],
  // +Y
  [
    [0, 1, 0],
    [0, 1, 1],
    [1, 1, 1],
  ],
  [
    [0, 1, 0],
    [1, 1, 1],
    [1, 1, 0],
  ],
  // -X
  [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 1],
  ],
  [
    [0, 0, 0],
    [0, 1, 1],
    [0, 1, 0],
  ],
  // +X
  [
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 1],
  ],
  [
    [1, 0, 0],
    [1, 1, 1],
    [1, 0, 1],
  ],
];

/** An axis-aligned solid box of `size` mm, sitting on the bed at the origin. */
export function binaryStlBox(size: number): Buffer {
  const buffer = Buffer.alloc(84 + FACES.length * 50);
  buffer.write(`orcaslicer-web test box ${size}mm`, 0, 'ascii');
  buffer.writeUInt32LE(FACES.length, 80);

  let offset = 84;
  for (const face of FACES) {
    const [a, b, c] = face;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    const normal = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(normal[0] as number, normal[1] as number, normal[2] as number) || 1;
    for (const component of normal) {
      buffer.writeFloatLE((component as number) / length, offset);
      offset += 4;
    }
    for (const vertex of face) {
      buffer.writeFloatLE(vertex[0] * size, offset);
      buffer.writeFloatLE(vertex[1] * size, offset + 4);
      buffer.writeFloatLE(vertex[2] * size, offset + 8);
      offset += 12;
    }
    offset += 2;
  }
  return buffer;
}
