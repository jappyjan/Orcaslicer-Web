import { describe, expect, it } from 'vitest';
import { LayerEncoder, decodeSegments, quantisationFor } from './encode.js';
import {
  FEATURE_NAMES,
  FeatureType,
  QUANT_MAX,
  SEGMENT_BYTES,
  U16_STRIDE,
  layerRange,
  type PreviewIndex,
} from './format.js';
import { featureFromName } from './features.js';

describe('the record layout', () => {
  it('is 18 bytes and stays typed-array friendly', () => {
    expect(SEGMENT_BYTES).toBe(18);
    expect(SEGMENT_BYTES % 2).toBe(0);
    expect(U16_STRIDE).toBe(9);
  });

  it('names every feature value exactly once', () => {
    const values = Object.values(FeatureType);
    expect(new Set(values).size).toBe(values.length);
    expect(FEATURE_NAMES.length).toBe(values.length);
    for (const [key, value] of Object.entries(FeatureType)) {
      expect(FEATURE_NAMES[value], `${key} needs a display name`).toBeTypeOf('string');
      expect(value).toBeLessThan(256); // it is stored in a uint8
    }
  });
});

describe('quantisation', () => {
  it('round-trips within half a step', () => {
    const q = quantisationFor([10, 20, 0], [110, 220, 50]);
    const encoder = new LayerEncoder(q, 4);
    const points: Array<[number, number, number]> = [
      [10, 20, 0],
      [110, 220, 50],
      [60.12345, 137.6789, 12.5],
    ];
    for (const [x, y, z] of points) {
      encoder.push(x, y, z, x, y, z, 420, 200, FeatureType.OuterWall, 0);
    }
    const decoded = decodeSegments(encoder.view(), q);
    expect(decoded).toHaveLength(3);
    for (const [index, [x, y, z]] of points.entries()) {
      const segment = decoded[index] as (typeof decoded)[number];
      expect(Math.abs(segment.x0 - x)).toBeLessThanOrEqual(q.scale[0] / 2 + 1e-9);
      expect(Math.abs(segment.y0 - y)).toBeLessThanOrEqual(q.scale[1] / 2 + 1e-9);
      expect(Math.abs(segment.z0 - z)).toBeLessThanOrEqual(q.scale[2] / 2 + 1e-9);
    }
    // The extremes are exact: they are the grid's ends.
    expect(decoded[0]?.x0).toBe(10);
    expect(decoded[1]?.x1).toBe(110);
  });

  it('gives a flat model a zero-scale Z rather than a division by zero', () => {
    const q = quantisationFor([0, 0, 0.2], [10, 10, 0.2]);
    expect(q.scale[2]).toBe(0);
    const encoder = new LayerEncoder(q, 2);
    encoder.push(0, 0, 0.2, 10, 10, 0.2, 400, 200, FeatureType.InnerWall, 0);
    expect(decodeSegments(encoder.view(), q)[0]?.z1).toBe(0.2);
  });

  it('clamps rather than wrapping when a point falls outside the grid', () => {
    // Cannot happen with a bounding box measured from the same toolpath, but a uint16
    // that wraps would put a segment on the far side of the bed.
    const q = quantisationFor([0, 0, 0], [10, 10, 10]);
    const encoder = new LayerEncoder(q, 2);
    encoder.push(-5, 15, 0, 0, 0, 0, 400, 200, FeatureType.Skirt, 0);
    const segment = decodeSegments(encoder.view(), q)[0];
    expect(segment?.x0).toBe(0);
    expect(segment?.y0).toBe(10);
  });

  it('keeps width, height, feature and tool distinct', () => {
    const q = quantisationFor([0, 0, 0], [1, 1, 1]);
    const encoder = new LayerEncoder(q, 2);
    encoder.push(0, 0, 0, 1, 1, 1, 393, 280, FeatureType.SupportInterface, 3);
    const segment = decodeSegments(encoder.view(), q)[0];
    expect(segment?.width).toBeCloseTo(0.393, 6);
    expect(segment?.height).toBeCloseTo(0.28, 6);
    expect(segment?.feature).toBe(FeatureType.SupportInterface);
    expect(segment?.tool).toBe(3);
  });

  it('grows past its initial capacity without corrupting earlier records', () => {
    const q = quantisationFor([0, 0, 0], [1000, 1000, 1000]);
    const encoder = new LayerEncoder(q, 1);
    for (let i = 0; i < 5000; i += 1) {
      encoder.push(i / 10, 0, 0, i / 10 + 1, 0, 0, 400, 200, FeatureType.SparseInfill, i % 4);
    }
    const decoded = decodeSegments(encoder.view(), q);
    expect(decoded).toHaveLength(5000);
    expect(decoded[0]?.x0).toBeCloseTo(0, 3);
    expect(decoded[4999]?.x0).toBeCloseTo(499.9, 2);
    expect(decoded[4999]?.tool).toBe(4999 % 4);
  });

  it('decodes from an odd byte offset by copying, not by throwing', () => {
    const q = quantisationFor([0, 0, 0], [10, 10, 10]);
    const encoder = new LayerEncoder(q, 2);
    encoder.push(1, 2, 3, 4, 5, 6, 400, 200, FeatureType.Brim, 1);
    const source = encoder.view();
    const shifted = new Uint8Array(source.byteLength + 1);
    shifted.set(source, 1);
    const decoded = decodeSegments(shifted.subarray(1), q);
    expect(decoded[0]?.x0).toBeCloseTo(1, 3);
    expect(decoded[0]?.feature).toBe(FeatureType.Brim);
  });

  it('reserves the whole uint16 range', () => {
    expect(QUANT_MAX).toBe(65535);
  });
});

describe('layerRange', () => {
  const index = {
    layers: {
      z: [0.2, 0.4, 0.6, 0.8],
      height: [0.2, 0.2, 0.2, 0.2],
      count: [10, 20, 0, 5],
      offset: [0, 180, 540, 540],
      featureMask: [0, 0, 0, 0],
    },
  } as unknown as PreviewIndex;

  it('covers an inclusive window', () => {
    expect(layerRange(index, 1, 2)).toEqual({ offset: 180, length: 360 });
    expect(layerRange(index, 0, 3)).toEqual({ offset: 0, length: 630 });
    expect(layerRange(index, 3, 3)).toEqual({ offset: 540, length: 90 });
  });

  it('handles an empty layer', () => {
    expect(layerRange(index, 2, 2)).toEqual({ offset: 540, length: 0 });
  });

  it('accepts the bounds in either order and clamps out-of-range ones', () => {
    expect(layerRange(index, 2, 1)).toEqual({ offset: 180, length: 360 });
    expect(layerRange(index, -5, 99)).toEqual({ offset: 0, length: 630 });
  });
});

describe('featureFromName', () => {
  it('reads the names OrcaSlicer 2.4.2 emits', () => {
    expect(featureFromName('Outer wall')).toBe(FeatureType.OuterWall);
    expect(featureFromName('Internal solid infill')).toBe(FeatureType.InternalSolidInfill);
    expect(featureFromName('Internal Bridge')).toBe(FeatureType.InternalBridge);
    expect(featureFromName('Support interface')).toBe(FeatureType.SupportInterface);
  });

  it('reads the legacy `;TYPE:` role names other slicers emit', () => {
    expect(featureFromName('External perimeter')).toBe(FeatureType.OuterWall);
    expect(featureFromName('Perimeter')).toBe(FeatureType.InnerWall);
    expect(featureFromName('Internal infill')).toBe(FeatureType.SparseInfill);
    expect(featureFromName('Wipe tower')).toBe(FeatureType.PrimeTower);
  });

  it('is whitespace- and case-insensitive', () => {
    expect(featureFromName('  outer WALL  ')).toBe(FeatureType.OuterWall);
  });

  it('falls back to Unknown for a role a later release invents', () => {
    expect(featureFromName('Quantum infill')).toBe(FeatureType.Unknown);
  });
});
