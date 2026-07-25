/**
 * Turning segments into bytes, and back.
 *
 * The encoder buffers exactly one layer. That is the whole memory story of the compiler:
 * a layer of the 42 MiB budget file is ~28 KB, so the resident set is dominated by the
 * read stream, not by the model.
 */

import {
  QUANT_MAX,
  type Quantisation,
  SEGMENT_BYTES,
  U16,
  U16_STRIDE,
  U8,
  type FeatureTypeValue,
} from './format.js';

/** A decoded segment, in millimetres. Used by tests and by any server-side consumer. */
export interface Segment {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Millimetres. 0 when the slicer never announced one. */
  width: number;
  /** Millimetres. 0 when the slicer never announced one. */
  height: number;
  feature: number;
  tool: number;
}

function quantise(value: number, origin: number, scale: number): number {
  if (scale <= 0) return 0;
  const q = Math.round((value - origin) / scale);
  return q < 0 ? 0 : q > QUANT_MAX ? QUANT_MAX : q;
}

/**
 * Build a quantisation grid that spans `min`..`max` exactly.
 *
 * A degenerate axis (a single-layer print has zero Z extent) gets a scale of 0, which
 * `dequantise` turns back into a constant `origin` — correct, and no division by zero.
 */
export function quantisationFor(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Quantisation {
  const scale: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const span = (max[axis] as number) - (min[axis] as number);
    scale[axis] = span > 0 ? span / QUANT_MAX : 0;
  }
  return { origin: [min[0], min[1], min[2]], scale };
}

/** Accumulates one layer's records into a growable buffer. */
export class LayerEncoder {
  private buffer: ArrayBuffer;
  private u16: Uint16Array;
  private u8: Uint8Array;
  private count = 0;
  private readonly q: Quantisation;

  constructor(quantisation: Quantisation, initialSegments = 4096) {
    this.q = quantisation;
    this.buffer = new ArrayBuffer(initialSegments * SEGMENT_BYTES);
    this.u16 = new Uint16Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
  }

  get segments(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }

  push(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    widthMicrons: number,
    heightMicrons: number,
    feature: FeatureTypeValue,
    tool: number,
  ): void {
    if ((this.count + 1) * SEGMENT_BYTES > this.buffer.byteLength) this.grow();
    const { origin, scale } = this.q;
    const base = this.count * U16_STRIDE;
    const u16 = this.u16;
    u16[base + U16.x0] = quantise(x0, origin[0], scale[0]);
    u16[base + U16.y0] = quantise(y0, origin[1], scale[1]);
    u16[base + U16.z0] = quantise(z0, origin[2], scale[2]);
    u16[base + U16.x1] = quantise(x1, origin[0], scale[0]);
    u16[base + U16.y1] = quantise(y1, origin[1], scale[1]);
    u16[base + U16.z1] = quantise(z1, origin[2], scale[2]);
    u16[base + U16.width] = widthMicrons > QUANT_MAX ? QUANT_MAX : widthMicrons;
    u16[base + U16.height] = heightMicrons > QUANT_MAX ? QUANT_MAX : heightMicrons;
    const byte = this.count * SEGMENT_BYTES;
    this.u8[byte + U8.feature] = feature;
    this.u8[byte + U8.tool] = tool;
    this.count += 1;
  }

  /** The encoded layer. Valid until the next `push`; copy it or write it now. */
  view(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.count * SEGMENT_BYTES);
  }

  private grow(): void {
    const next = new ArrayBuffer(this.buffer.byteLength * 2);
    new Uint8Array(next).set(this.u8);
    this.buffer = next;
    this.u16 = new Uint16Array(next);
    this.u8 = new Uint8Array(next);
  }
}

/**
 * Decode a layer chunk.
 *
 * This is the reference implementation of the client-side read path — it is what the
 * round-trip test checks the encoder against, and what the three.js renderer should
 * mirror with typed-array views rather than objects.
 */
export function decodeSegments(
  bytes: Uint8Array,
  quantisation: Quantisation,
  from = 0,
  count = Math.floor(bytes.byteLength / SEGMENT_BYTES) - from,
): Segment[] {
  const total = Math.floor(bytes.byteLength / SEGMENT_BYTES);
  const start = Math.max(0, Math.min(from, total));
  const end = Math.max(start, Math.min(start + count, total));

  // A Uint16Array view needs a 2-byte-aligned start; a chunk read out of a larger buffer
  // may not be, so copy in that (rare) case rather than throwing.
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : new Uint8Array(bytes.slice().buffer);
  const u16 = new Uint16Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 2),
  );
  const u8 = aligned;

  const { origin, scale } = quantisation;
  const out: Segment[] = [];
  for (let index = start; index < end; index += 1) {
    const base = index * U16_STRIDE;
    const byte = index * SEGMENT_BYTES;
    out.push({
      x0: origin[0] + (u16[base + U16.x0] as number) * scale[0],
      y0: origin[1] + (u16[base + U16.y0] as number) * scale[1],
      z0: origin[2] + (u16[base + U16.z0] as number) * scale[2],
      x1: origin[0] + (u16[base + U16.x1] as number) * scale[0],
      y1: origin[1] + (u16[base + U16.y1] as number) * scale[1],
      z1: origin[2] + (u16[base + U16.z1] as number) * scale[2],
      width: (u16[base + U16.width] as number) / 1000,
      height: (u16[base + U16.height] as number) / 1000,
      feature: u8[byte + U8.feature] as number,
      tool: u8[byte + U8.tool] as number,
    });
  }
  return out;
}
