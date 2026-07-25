/**
 * `G2` / `G3` arc interpolation.
 *
 * VERIFIED DEVIATION #4 (docs/SPEC.md): Orca's arc fitting turns a share of extrusions
 * into `G2`/`G3`, so a parser that only understands `G1` silently drops them. MEASURED on
 * our own binary: a 15-layer curved-wall slice contains 862 arcs against 2 900 linear
 * extrusions — a quarter of the toolpath. On a cylinder the missing quarter is the whole
 * outside of the part.
 *
 * Arcs are flattened here, at parse time, into ordinary straight segments. The client
 * therefore never learns that arcs exist: one primitive, one code path, one draw call
 * per layer. Flattening on the GPU instead would mean shipping a second vertex format
 * and a second shader to save a few hundred kilobytes, which is the wrong trade on a
 * phone.
 */

/** Chord tolerance in millimetres: the furthest a flattened chord may sit from the true arc. */
export const DEFAULT_ARC_TOLERANCE_MM = 0.02;

/**
 * Hard ceiling on the chords one arc may produce.
 *
 * A degenerate arc — one whose radius the slicer wrote with more optimism than the
 * endpoints support — must not be able to turn a 40 MB input into an unbounded output.
 */
export const MAX_ARC_SEGMENTS = 256;

export interface ArcMove {
  x0: number;
  y0: number;
  z0: number;
  /** Target. Equal to the start for a full circle. */
  x1: number;
  y1: number;
  z1: number;
  /** Centre offset from the start point. `NaN` when the move used `R` instead. */
  i: number;
  j: number;
  /** Signed radius form. `NaN` when `I`/`J` were given. */
  r: number;
  /** `G2` is clockwise, `G3` counter-clockwise. */
  clockwise: boolean;
}

/** Receives every point after the start, the last of which is exactly the target. */
export type PointSink = (x: number, y: number, z: number) => void;

const TWO_PI = Math.PI * 2;

/**
 * Flatten an arc, calling `sink` once per chord endpoint.
 *
 * Returns the number of chords emitted, or 0 when the arc is degenerate — in which case
 * nothing is emitted and the caller should fall back to a straight move, so a malformed
 * arc loses its curvature rather than the toolpath losing the extrusion.
 */
export function interpolateArc(
  move: ArcMove,
  sink: PointSink,
  toleranceMm = DEFAULT_ARC_TOLERANCE_MM,
): number {
  const centre = arcCentre(move);
  if (centre === undefined) return 0;
  const [cx, cy] = centre;

  const radius = Math.hypot(move.x0 - cx, move.y0 - cy);
  if (!(radius > 0) || !Number.isFinite(radius)) return 0;

  const startAngle = Math.atan2(move.y0 - cy, move.x0 - cx);
  const endAngle = Math.atan2(move.y1 - cy, move.x1 - cx);

  let sweep = move.clockwise ? startAngle - endAngle : endAngle - startAngle;
  // A sweep of exactly zero is the full-circle case: G2/G3 with the endpoint omitted (so
  // it defaults to the current position) means "all the way round", not "stay put".
  // MEASURED: 2.4.2's machine start G-code contains bare `G2 I0.5 J0 F300` nozzle-wipe
  // circles, so this is a real input shape and not a theoretical one.
  while (sweep <= 0) sweep += TWO_PI;
  while (sweep > TWO_PI) sweep -= TWO_PI;
  const signedSweep = move.clockwise ? -sweep : sweep;

  const steps = chordCount(radius, sweep, toleranceMm);
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    const angle = startAngle + signedSweep * t;
    sink(
      cx + radius * Math.cos(angle),
      cy + radius * Math.sin(angle),
      move.z0 + (move.z1 - move.z0) * t,
    );
  }
  // The final point is the declared target, never a recomputed one: trigonometry would
  // leave a sub-micron gap between this arc's end and the next move's start, and those
  // gaps are visible as pinholes once the client extrudes the path into a ribbon.
  sink(move.x1, move.y1, move.z1);
  return steps;
}

/**
 * Chords needed to keep the sagitta under `tolerance`.
 *
 * For a chord subtending 2θ on a circle of radius r the sagitta is r(1 − cos θ), so the
 * largest admissible θ is acos(1 − tolerance/r).
 */
export function chordCount(radius: number, sweep: number, tolerance: number): number {
  if (radius <= tolerance) return 1;
  const maxHalfAngle = Math.acos(1 - tolerance / radius);
  if (!(maxHalfAngle > 0)) return MAX_ARC_SEGMENTS;
  const steps = Math.ceil(sweep / (2 * maxHalfAngle));
  return Math.min(MAX_ARC_SEGMENTS, Math.max(1, steps));
}

/**
 * The arc's centre.
 *
 * `I`/`J` — offsets from the start point — is what OrcaSlicer 2.4.2 emits; MEASURED zero
 * `R`-form arcs across every slice taken while building this. `R` is implemented anyway
 * because it is standard G-code and a different machine profile's post-processor may
 * produce it, using the geometric construction grbl and LinuxCNC agree on: a positive
 * radius selects the minor arc, a negative one the major arc.
 */
function arcCentre(move: ArcMove): [number, number] | undefined {
  if (Number.isFinite(move.i) || Number.isFinite(move.j)) {
    const i = Number.isFinite(move.i) ? move.i : 0;
    const j = Number.isFinite(move.j) ? move.j : 0;
    if (i === 0 && j === 0) return undefined;
    return [move.x0 + i, move.y0 + j];
  }

  if (!Number.isFinite(move.r) || move.r === 0) return undefined;
  const dx = move.x1 - move.x0;
  const dy = move.y1 - move.y0;
  const distanceSq = dx * dx + dy * dy;
  // R-form cannot express a full circle: with coincident endpoints every circle of that
  // radius through the point is a solution.
  if (distanceSq === 0) return undefined;

  const discriminant = 4 * move.r * move.r - distanceSq;
  if (discriminant < 0) return undefined; // the endpoints are further apart than 2R

  const distance = Math.sqrt(distanceSq);
  let h2d = -Math.sqrt(discriminant) / distance;
  if (!move.clockwise) h2d = -h2d;
  // A negative radius asks for the major arc, which is the centre on the other side.
  if (move.r < 0) h2d = -h2d;
  return [move.x0 + 0.5 * (dx - dy * h2d), move.y0 + 0.5 * (dy + dx * h2d)];
}
