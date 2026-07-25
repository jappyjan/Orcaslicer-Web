import { describe, expect, it } from 'vitest';
import { MAX_ARC_SEGMENTS, type ArcMove, chordCount, interpolateArc } from './arcs.js';

function collect(
  move: ArcMove,
  tolerance?: number,
): { points: Array<[number, number, number]>; chords: number } {
  const points: Array<[number, number, number]> = [];
  const chords = interpolateArc(move, (x, y, z) => points.push([x, y, z]), tolerance);
  return { points, chords };
}

const base = { z0: 0, z1: 0, i: Number.NaN, j: Number.NaN, r: Number.NaN, clockwise: false };

describe('interpolateArc', () => {
  it('walks a quarter circle counter-clockwise (G3)', () => {
    // Centre at the origin, radius 10, from (10,0) to (0,10).
    const { points } = collect({ ...base, x0: 10, y0: 0, x1: 0, y1: 10, i: -10, j: 0 });
    expect(points.length).toBeGreaterThan(2);
    for (const [x, y] of points) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
    // Counter-clockwise: the first step must move up and left, not down.
    expect(points[0]?.[1]).toBeGreaterThan(0);
    expect(points.at(-1)).toEqual([0, 10, 0]);
  });

  it('walks the same quarter clockwise (G2) the long way round', () => {
    const { points } = collect({
      ...base,
      x0: 10,
      y0: 0,
      x1: 0,
      y1: 10,
      i: -10,
      j: 0,
      clockwise: true,
    });
    for (const [x, y] of points) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
    // G2 from (10,0) to (0,10) about the origin is 270°, so it dips below the axis.
    expect(Math.min(...points.map((p) => p[1]))).toBeLessThan(-9);
  });

  it('treats a coincident endpoint as a full circle, not a no-op', () => {
    // MEASURED: 2.4.2 machine start G-code contains bare `G2 I0.5 J0 F300`.
    const { points } = collect({
      ...base,
      x0: 100,
      y0: 50,
      x1: 100,
      y1: 50,
      i: 0.5,
      j: 0,
      clockwise: true,
    });
    expect(points.length).toBeGreaterThan(8);
    for (const [x, y] of points) expect(Math.hypot(x - 100.5, y - 50)).toBeCloseTo(0.5, 6);
    expect(points.at(-1)).toEqual([100, 50, 0]);
  });

  it('ends exactly on the declared target', () => {
    const { points } = collect({ ...base, x0: 1, y0: 2, x1: 3.14159, y1: 2.71828, i: 4, j: 4 });
    expect(points.at(-1)).toEqual([3.14159, 2.71828, 0]);
  });

  it('interpolates Z along a helical arc', () => {
    const { points } = collect({
      ...base,
      x0: 10,
      y0: 0,
      z0: 1,
      x1: 0,
      y1: 10,
      z1: 2,
      i: -10,
      j: 0,
    });
    const zs = points.map((p) => p[2]);
    expect(zs.at(-1)).toBe(2);
    for (let k = 1; k < zs.length; k += 1) {
      expect(zs[k] as number).toBeGreaterThan(zs[k - 1] as number);
    }
  });

  it('honours the chord tolerance', () => {
    const loose = collect({ ...base, x0: 10, y0: 0, x1: -10, y1: 0, i: -10, j: 0 }, 1);
    const tight = collect({ ...base, x0: 10, y0: 0, x1: -10, y1: 0, i: -10, j: 0 }, 0.001);
    expect(tight.points.length).toBeGreaterThan(loose.points.length * 4);
  });

  it('supports the R form, minor arc for positive R', () => {
    // A semicircle of radius 5 has its endpoints 10 apart; use a chord of 6 so the
    // minor/major distinction is visible.
    const minor = collect({ ...base, x0: -3, y0: 0, x1: 3, y1: 0, r: 5 });
    const major = collect({ ...base, x0: -3, y0: 0, x1: 3, y1: 0, r: -5 });
    const minorBulge = Math.max(...minor.points.map((p) => Math.abs(p[1])));
    const majorBulge = Math.max(...major.points.map((p) => Math.abs(p[1])));
    expect(minorBulge).toBeLessThan(majorBulge);
    // Counter-clockwise from (-3,0) to (3,0) on the minor arc puts the centre above.
    expect(minorBulge).toBeCloseTo(1, 6);
    for (const [x, y] of minor.points) {
      expect(Math.hypot(x - 0, y - 4)).toBeCloseTo(5, 6);
    }
  });

  it('reports a degenerate arc instead of emitting nonsense', () => {
    expect(collect({ ...base, x0: 0, y0: 0, x1: 1, y1: 0, i: 0, j: 0 }).chords).toBe(0);
    // Endpoints further apart than 2R.
    expect(collect({ ...base, x0: 0, y0: 0, x1: 100, y1: 0, r: 1 }).chords).toBe(0);
    // R form cannot express a full circle.
    expect(collect({ ...base, x0: 0, y0: 0, x1: 0, y1: 0, r: 5 }).chords).toBe(0);
  });

  it('caps the chords one arc can produce', () => {
    expect(chordCount(1e9, Math.PI * 2, 0.02)).toBe(MAX_ARC_SEGMENTS);
    const { points } = collect({ ...base, x0: 1e6, y0: 0, x1: -1e6, y1: 0, i: -1e6, j: 0 }, 1e-6);
    expect(points.length).toBeLessThanOrEqual(MAX_ARC_SEGMENTS);
  });
});
