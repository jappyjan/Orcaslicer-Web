/**
 * The camera gestures, written for a thumb.
 *
 * Hard constraint #5 in its most literal form. This is ~200 lines of pointer handling
 * instead of three.js's `OrbitControls` for reasons that are not stylistic:
 *
 *  - OrbitControls maps *one* finger to rotate and *two* to dolly **and** pan at once, so
 *    a two-finger pan on a phone always zooms a little as well. Here the two are
 *    separated by intent: a pinch whose distance changed is a zoom, a pinch whose midpoint
 *    moved is a pan, and the dominant one wins per frame.
 *  - A tap has to be distinguishable from a small drag, because tapping is how you select
 *    an object. That needs a movement and time threshold owned by the same code that owns
 *    the drag.
 *  - It brings a `domElement.style.touchAction` contract, `enableDamping`'s rAF loop and a
 *    keyboard/mouse surface this app has no use for.
 *
 * The camera orbits a target on the bed, Z-up, in millimetres. Everything is spherical:
 * azimuth, elevation, distance — the same three numbers the M5 preview will want to share.
 */

import { Spherical, Vector2, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';

/** Below this the camera would look up through the plate; above it, straight down. */
const MIN_ELEVATION = 0.08;
const MAX_ELEVATION = Math.PI / 2 - 0.02;

/** A press that moves less than this, for less than this long, is a tap. */
const TAP_SLOP_PX = 12;
const TAP_MS = 400;

export interface CameraState {
  target: Vector3;
  spherical: Spherical;
}

export interface TouchControlOptions {
  camera: PerspectiveCamera;
  element: HTMLElement;
  /** Called whenever the camera moved, so the scene can render on demand. */
  onChange: () => void;
  /** A tap that was not a drag, in CSS pixels relative to the element. */
  onTap: (x: number, y: number) => void;
  minDistance: number;
  maxDistance: number;
}

interface Pointer {
  id: number;
  x: number;
  y: number;
}

export class TouchControls {
  readonly target = new Vector3();
  private readonly spherical = new Spherical(1, Math.PI / 3, Math.PI / 4);
  private readonly options: TouchControlOptions;
  private readonly pointers: Pointer[] = [];
  private pinchDistance = 0;
  private readonly pinchCentre = new Vector2();
  private downAt = 0;
  private readonly downPoint = new Vector2();
  private moved = 0;
  private disposed = false;

  constructor(options: TouchControlOptions) {
    this.options = options;
    const element = options.element;
    // Without this the browser scrolls the page instead of giving us the gesture, and on
    // iOS a two-finger drag becomes a page zoom.
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    // Desktop is the degraded case, but a scroll wheel costs four lines.
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', preventDefault);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const element = this.options.element;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('wheel', this.onWheel);
    element.removeEventListener('contextmenu', preventDefault);
  }

  /** Point the camera at `target` from `distance`, keeping the current angles. */
  frame(target: Vector3, distance: number): void {
    this.target.copy(target);
    this.spherical.radius = this.clampDistance(distance);
    this.apply();
  }

  reset(): void {
    this.spherical.theta = Math.PI / 4;
    this.spherical.phi = Math.PI / 3;
    this.apply();
  }

  /** Straight down. The one view where "where is it on the bed" is unambiguous. */
  top(): void {
    this.spherical.theta = 0;
    this.spherical.phi = 0.02;
    this.apply();
  }

  apply(): void {
    const { camera } = this.options;
    // three.js's Spherical is Y-up; the plate is Z-up (that is the printer's own frame,
    // and the frame the G-code is in), so the components are mapped rather than used
    // directly. phi is measured from the zenith, i.e. from straight above the bed.
    const sinPhi = Math.sin(this.spherical.phi);
    const offset = new Vector3(
      this.spherical.radius * sinPhi * Math.sin(this.spherical.theta),
      this.spherical.radius * sinPhi * Math.cos(this.spherical.theta),
      this.spherical.radius * Math.cos(this.spherical.phi),
    );
    camera.up.set(0, 0, 1);
    camera.position.copy(this.target).add(offset);
    camera.lookAt(this.target);
    camera.updateMatrixWorld();
    this.options.onChange();
  }

  private clampDistance(distance: number): number {
    return Math.min(this.options.maxDistance, Math.max(this.options.minDistance, distance));
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.options.element.setPointerCapture?.(event.pointerId);
    this.pointers.push({ id: event.pointerId, x: event.clientX, y: event.clientY });
    if (this.pointers.length === 1) {
      this.downAt = performance.now();
      this.downPoint.set(event.clientX, event.clientY);
      this.moved = 0;
    } else if (this.pointers.length === 2) {
      this.pinchDistance = this.distance();
      this.centre(this.pinchCentre);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.find((candidate) => candidate.id === event.pointerId);
    if (!pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    this.moved = Math.max(
      this.moved,
      this.downPoint.distanceTo(new Vector2(event.clientX, event.clientY)),
    );

    if (this.pointers.length === 1) {
      this.orbit(dx, dy);
      return;
    }
    if (this.pointers.length >= 2) {
      const distance = this.distance();
      const centre = new Vector2();
      this.centre(centre);

      // Zoom and pan are decided per move, not blended: a two-finger drag that keeps the
      // fingers the same distance apart is a pan and must not creep in scale, and a pinch
      // whose centre wanders by a few pixels must not slide the plate.
      const scaleChange = this.pinchDistance > 0 ? Math.abs(distance - this.pinchDistance) : 0;
      const centreShift = centre.distanceTo(this.pinchCentre);
      if (scaleChange > centreShift) {
        if (this.pinchDistance > 0 && distance > 0) {
          this.dolly(this.pinchDistance / distance);
        }
      } else {
        this.pan(centre.x - this.pinchCentre.x, centre.y - this.pinchCentre.y);
      }
      this.pinchDistance = distance;
      this.pinchCentre.copy(centre);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const index = this.pointers.findIndex((candidate) => candidate.id === event.pointerId);
    if (index >= 0) this.pointers.splice(index, 1);
    this.options.element.releasePointerCapture?.(event.pointerId);

    if (this.pointers.length === 0) {
      const elapsed = performance.now() - this.downAt;
      if (this.moved <= TAP_SLOP_PX && elapsed <= TAP_MS) {
        const rect = this.options.element.getBoundingClientRect();
        this.options.onTap(event.clientX - rect.left, event.clientY - rect.top);
      }
    }
    if (this.pointers.length === 1) {
      // Coming out of a pinch: re-anchor so the remaining finger does not jump the camera.
      this.moved = TAP_SLOP_PX + 1;
      this.pinchDistance = 0;
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.dolly(event.deltaY > 0 ? 1.1 : 1 / 1.1);
  };

  private orbit(dx: number, dy: number): void {
    const element = this.options.element;
    const width = element.clientWidth || 1;
    const height = element.clientHeight || 1;
    // A full drag across the viewport is a full turn horizontally and a quarter turn
    // vertically — enough to get anywhere without a fiddly second drag.
    this.spherical.theta -= (dx / width) * Math.PI * 2;
    // Clamped so the camera never goes under the plate — from below, a plate you cannot
    // see through is a black screen with no way back.
    this.spherical.phi = Math.min(
      MAX_ELEVATION,
      Math.max(MIN_ELEVATION, this.spherical.phi - (dy / height) * Math.PI),
    );
    this.apply();
  }

  private dolly(factor: number): void {
    this.spherical.radius = this.clampDistance(this.spherical.radius * factor);
    this.apply();
  }

  /**
   * Slide the target across the plate, in the screen's own directions.
   *
   * The pan is scaled by the camera's distance so a finger keeps the same amount of the
   * plate under it whatever the zoom — panning that speeds up as you zoom out is the
   * single most common way a 3D view feels wrong on a phone.
   */
  private pan(dx: number, dy: number): void {
    const { camera, element } = this.options;
    const height = element.clientHeight || 1;
    const worldPerPixel =
      (2 * Math.tan(((camera.fov / 2) * Math.PI) / 180) * this.spherical.radius) / height;

    const right = new Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrix, 1);
    this.target.addScaledVector(right, -dx * worldPerPixel);
    this.target.addScaledVector(up, dy * worldPerPixel);
    this.apply();
  }

  private distance(): number {
    const [a, b] = this.pointers;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private centre(out: Vector2): void {
    const [a, b] = this.pointers;
    if (!a || !b) return;
    out.set((a.x + b.x) / 2, (a.y + b.y) / 2);
  }
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
