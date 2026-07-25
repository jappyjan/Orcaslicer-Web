/**
 * The build plate, as three.js objects.
 *
 * Extracted from `plater-scene.ts` when M5 arrived, because the G-code preview draws the
 * *same* plate as the plater and the two must not drift: a preview whose bed is 256 × 256
 * while the plater's is 350 × 320 would put the toolpath in a visibly different place on
 * screen for the same printer. One builder, two scenes.
 *
 * Everything is in the printer's own frame — X right, Y back, Z up, millimetres, origin at
 * `printable_area`'s origin — which is also the frame the G-code names its coordinates in
 * (modulo `extruder_offset`; see `preview-scene.ts`).
 */

import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three';
import type { Object3D } from 'three';
import type { BedSpec } from '@orca-web/shared';

export const BED_COLOURS = {
  bed: 0x121924,
  grid: 0x2a3646,
  border: 0x64748b,
  exclude: 0x7f1d1d,
};

export interface BedView {
  group: Group;
  /** Longest side of the plate's bounding box, millimetres. The camera's unit of distance. */
  size: number;
  /** Centre of the plate, on it. */
  centre: Vector3;
}

/** How much of the canvas the floating panels are covering, in CSS pixels. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * How far back a perspective camera has to be for a sphere of `radius` to clear the part
 * of the canvas that no panel is covering.
 *
 * The panels are *over* the canvas, not beside it, so a fit computed from the canvas is
 * wrong by exactly the ratio the panels cover: on a 390 x 844 phone with the bottom sheet
 * at half height the free rectangle is about 310 x 335, and a 256 mm plate fitted to
 * 390 x 844 would have a third of itself underneath the dock. Each axis is scaled by that
 * ratio and the further of the two wins.
 *
 * Both scenes use it, for the same reason `bed.ts` exists at all: two implementations of
 * "how far away is far enough" would drift, and the drift would show up as the preview
 * and the plate framing the same object differently.
 */
export function fitDistance(
  camera: { fov: number },
  canvas: { clientWidth: number; clientHeight: number },
  insets: Insets,
  radius: number,
): number {
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  // 80px floors: a sheet dragged to full height leaves a sliver, and dividing by it would
  // send the camera to the far plane.
  const freeWidth = Math.max(80, width - insets.left - insets.right);
  const freeHeight = Math.max(80, height - insets.top - insets.bottom);
  const halfFov = Math.tan(((camera.fov / 2) * Math.PI) / 180);
  const vertical = (radius / halfFov) * (height / freeHeight);
  const horizontal = (radius / (halfFov * (width / height))) * (width / freeWidth);
  // 8 % of air. An exact fit puts the plate's corners on the edge of the free rectangle,
  // and the edge of the free rectangle is where the panels start.
  return Math.max(vertical, horizontal) * 1.08;
}

/** Draw the machine's real plate: `printable_area`, `bed_exclude_area`, a 10 mm grid. */
export function buildBed(bed: BedSpec): BedView | null {
  if (bed.printableArea.length < 3) return null;
  const group = new Group();

  const shape = new Shape();
  bed.printableArea.forEach((point, index) => {
    if (index === 0) shape.moveTo(point[0], point[1]);
    else shape.lineTo(point[0], point[1]);
  });
  shape.closePath();
  const surface = new Mesh(
    new ShapeGeometry(shape),
    new MeshLambertMaterial({ color: BED_COLOURS.bed, side: DoubleSide }),
  );
  surface.position.z = -0.05; // under the grid, so the lines are not z-fought away
  surface.name = 'bed';
  group.add(surface);

  const xs = bed.printableArea.map((point) => point[0]);
  const ys = bed.printableArea.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY);

  const step = size > 400 ? 50 : 10;
  const lines: number[] = [];
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
    lines.push(x, minY, 0, x, maxY, 0);
  }
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) {
    lines.push(minX, y, 0, maxX, y, 0);
  }
  const grid = new BufferGeometry();
  grid.setAttribute('position', new Float32BufferAttribute(lines, 3));
  group.add(new LineSegments(grid, new LineBasicMaterial({ color: BED_COLOURS.grid })));

  const border: number[] = [];
  bed.printableArea.forEach((point, index) => {
    const next = bed.printableArea[(index + 1) % bed.printableArea.length] as [number, number];
    border.push(point[0], point[1], 0.02, next[0], next[1], 0.02);
  });
  const borderGeometry = new BufferGeometry();
  borderGeometry.setAttribute('position', new Float32BufferAttribute(border, 3));
  group.add(new LineSegments(borderGeometry, new LineBasicMaterial({ color: BED_COLOURS.border })));

  if (bed.excludeArea.length >= 3) {
    // The nozzle-wipe pad and friends. The engine refuses to slice an object standing on
    // one (exit -52), so it is drawn rather than left as a surprise.
    const excluded = new Shape();
    bed.excludeArea.forEach((point, index) => {
      if (index === 0) excluded.moveTo(point[0], point[1]);
      else excluded.lineTo(point[0], point[1]);
    });
    excluded.closePath();
    const mesh = new Mesh(
      new ShapeGeometry(excluded),
      new MeshLambertMaterial({ color: BED_COLOURS.exclude, transparent: true, opacity: 0.55 }),
    );
    mesh.position.z = 0.01;
    group.add(mesh);
  }

  return { group, size, centre: new Vector3((minX + maxX) / 2, (minY + maxY) / 2, 0) };
}

/** Free the GPU buffers of everything under `object`, including `object` itself. */
export function disposeTree(object: Object3D): void {
  object.traverse((node) => {
    const holder = node as { geometry?: { dispose(): void }; material?: { dispose(): void } };
    holder.geometry?.dispose();
    holder.material?.dispose();
  });
}
