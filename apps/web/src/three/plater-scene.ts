/**
 * The WebGL view: a build plate, the objects on it, and the gestures that move the camera.
 *
 * ## Coordinate frame (M5 will want to share this)
 *
 * World units are **millimetres** and the frame is the **printer's own**: X right, Y back,
 * **Z up**, origin at the bed's `printable_area` origin. So a vertex's world position is
 * the number the G-code would name — modulo `extruder_offset`, which the firmware applies
 * and the plate does not (MEASURED: a BBL X1C ships `0x2`, so an object centred at
 * y = 120 extrudes at y = 118). Camera is a `PerspectiveCamera` with `up = (0,0,1)`,
 * orbiting a target on the plate.
 *
 * ## What is deliberately absent
 *
 * There is **no transform gizmo**. Hard constraint #5, and the milestone says it outright:
 * drag handles are unusable with a thumb — they are small, they need hover to discover,
 * and the finger covers the thing being dragged. Objects are moved with the sliders and
 * number fields in `PlaterScreen`; the only thing a finger does in here is move the
 * camera and tap to select.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry } from 'three';
import type { BedSpec } from '@orca-web/shared';
import type { FitProblem, Instance } from '../state/plate.ts';
import { matrixOf, positionOf } from '../state/plate.ts';
import { buildBed, disposeTree } from './bed.ts';
import { TouchControls } from './touch-controls.ts';

const COLOURS = {
  object: 0x7dd3fc,
  selected: 0x38bdf8,
  problem: 0xf87171,
  outline: 0xe8eef6,
};

export interface PlaterSceneCallbacks {
  onSelect: (id: string | null) => void;
}

interface InstanceView {
  mesh: Mesh;
  outline: LineSegments;
  geometry: BufferGeometry;
}

export class PlaterScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: TouchControls;
  private readonly bedGroup = new Group();
  private readonly objects = new Group();
  private readonly views = new Map<string, InstanceView>();
  private readonly callbacks: PlaterSceneCallbacks;
  private readonly canvas: HTMLCanvasElement;
  private bedSize = 256;
  private dirty = true;
  private frame = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, callbacks: PlaterSceneCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      // The plate preview is grabbed straight off this canvas with `toBlob`, which needs
      // the drawing buffer to still be there after the frame ends.
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(new Color(0x0b1016), 1);
    this.scene.background = new Color(0x0b1016);

    this.camera = new PerspectiveCamera(45, 1, 1, 4000);
    this.camera.up.set(0, 0, 1);

    this.scene.add(new AmbientLight(0xffffff, 1.4));
    const key = new DirectionalLight(0xffffff, 1.9);
    key.position.set(0.4, -0.8, 1);
    this.scene.add(key);
    const fill = new DirectionalLight(0x93a3b8, 0.8);
    fill.position.set(-0.6, 0.5, 0.4);
    this.scene.add(fill);
    this.scene.add(this.bedGroup);
    this.scene.add(this.objects);

    this.controls = new TouchControls({
      camera: this.camera,
      element: canvas,
      onChange: () => this.invalidate(),
      onTap: (x, y) => this.pick(x, y),
      minDistance: 30,
      maxDistance: 3000,
    });
    this.controls.frame(new Vector3(128, 128, 0), 420);
    this.resize();
    this.loop();
  }

  // -- lifecycle ------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    for (const view of this.views.values()) this.disposeView(view);
    this.views.clear();
    this.clearBed();
    this.renderer.dispose();
  }

  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Render only when something changed.
   *
   * A continuous rAF loop on a phone is a hot device and a flat battery for a static
   * picture; the scene is nearly always static.
   */
  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  };

  resize(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    // Capped at 2: a 3x device pixel ratio triples the fragment cost for a difference
    // nobody can see on a 6-inch screen.
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  // -- the plate ------------------------------------------------------------

  private clearBed(): void {
    for (const child of [...this.bedGroup.children]) {
      this.bedGroup.remove(child);
      disposeTree(child);
    }
  }

  /**
   * Draw the machine's real plate: `printable_area`, `bed_exclude_area`, height.
   *
   * The geometry itself lives in `bed.ts` because M5's preview draws the same plate, and
   * two implementations of "where is the bed" would eventually disagree about it.
   */
  setBed(bed: BedSpec | null): void {
    this.clearBed();
    const view = bed ? buildBed(bed) : null;
    if (!view) {
      this.invalidate();
      return;
    }
    this.bedGroup.add(view.group);
    this.bedSize = view.size;

    // 1.25 x the plate's longest side, looking slightly above it: the plate fills the
    // viewport on a 390px screen without the near corner falling out of frame.
    this.controls.frame(
      new Vector3(view.centre.x, view.centre.y, this.bedSize * 0.06),
      this.bedSize * 1.25,
    );
    this.invalidate();
  }

  // -- the objects ----------------------------------------------------------

  /**
   * Bring the scene in line with the plate.
   *
   * Called on every state change, so it reconciles rather than rebuilds: the mesh for an
   * instance survives a move, and only its matrix and colour change.
   */
  sync(
    instances: readonly Instance[],
    geometries: ReadonlyMap<string, BufferGeometry>,
    selectedId: string | null,
    problems: ReadonlyMap<string, FitProblem>,
  ): void {
    const seen = new Set<string>();
    for (const instance of instances) {
      const geometry = geometries.get(instance.modelId);
      if (!geometry) continue;
      seen.add(instance.id);
      let view = this.views.get(instance.id);
      if (!view || view.geometry !== geometry) {
        if (view) this.removeView(instance.id, view);
        view = this.createView(instance.id, geometry);
      }

      const matrix = matrixOf(instance);
      const [px, py, pz] = positionOf(instance);
      // world = matrix · vertex + pos, exactly as the engine will be told. Setting the
      // matrix by hand rather than through position/quaternion/scale keeps that identity
      // visible instead of re-deriving it from three's decomposition.
      const m = new Matrix4().set(
        matrix[0],
        matrix[1],
        matrix[2],
        px,
        matrix[3],
        matrix[4],
        matrix[5],
        py,
        matrix[6],
        matrix[7],
        matrix[8],
        pz,
        0,
        0,
        0,
        1,
      );
      view.mesh.matrix.copy(m);
      view.mesh.matrixAutoUpdate = false;
      view.mesh.updateMatrixWorld(true);
      view.outline.matrix.copy(m);
      view.outline.matrixAutoUpdate = false;
      view.outline.updateMatrixWorld(true);

      const problem = problems.get(instance.id);
      const material = view.mesh.material as MeshLambertMaterial;
      material.color.set(
        problem !== undefined
          ? COLOURS.problem
          : instance.id === selectedId
            ? COLOURS.selected
            : COLOURS.object,
      );
      material.emissive.set(instance.id === selectedId ? 0x0f3b52 : 0x000000);
      view.outline.visible = instance.id === selectedId;
    }

    for (const [id, view] of [...this.views]) {
      if (!seen.has(id)) this.removeView(id, view);
    }
    this.invalidate();
  }

  private createView(id: string, geometry: BufferGeometry): InstanceView {
    const mesh = new Mesh(
      geometry,
      new MeshLambertMaterial({ color: COLOURS.object, flatShading: true }),
    );
    mesh.userData.instanceId = id;
    // The selection marker is an edge outline rather than a floating handle: it reads at
    // a glance on a small screen and it cannot be mistaken for something to drag.
    const outline = new LineSegments(
      new EdgesGeometry(geometry, 35),
      new LineBasicMaterial({ color: COLOURS.outline }),
    );
    outline.visible = false;
    this.objects.add(mesh);
    this.objects.add(outline);
    const view = { mesh, outline, geometry };
    this.views.set(id, view);
    return view;
  }

  private removeView(id: string, view: InstanceView): void {
    this.objects.remove(view.mesh);
    this.objects.remove(view.outline);
    this.disposeView(view);
    this.views.delete(id);
  }

  private disposeView(view: InstanceView): void {
    // The geometry is shared between instances and owned by the cache; only the things
    // this view created are disposed.
    (view.mesh.material as MeshLambertMaterial).dispose();
    view.outline.geometry.dispose();
    (view.outline.material as LineBasicMaterial).dispose();
  }

  // -- interaction ----------------------------------------------------------

  /** Tap to select. A tap on nothing clears the selection. */
  private pick(x: number, y: number): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), this.camera);
    const hits = raycaster.intersectObjects(
      [...this.views.values()].map((view) => view.mesh),
      false,
    );
    const hit = hits[0]?.object.userData.instanceId;
    this.callbacks.onSelect(typeof hit === 'string' ? hit : null);
  }

  resetView(): void {
    this.controls.reset();
  }

  topView(): void {
    this.controls.top();
  }

  // -- the plate preview ----------------------------------------------------

  /**
   * Render a square preview of the plate and hand back a PNG.
   *
   * SPEC: "the blank thumbnail is our problem to solve." The slicer cannot make one — it
   * needs OpenGL and the container has no display server — and VERIFIED DEVIATION #5 says
   * `--min-save` leaves the archive with no `Metadata/plate_N.png` at all, so the printer's
   * screen shows an empty preview unless this one gets written in.
   *
   * Rendered from a fixed three-quarter view rather than from wherever the user left the
   * camera: the preview is an identifier on a printer's screen, and it should look the
   * same for the same plate.
   */
  async captureThumbnail(size = 512): Promise<Blob | null> {
    const previousSize = new Vector2();
    this.renderer.getSize(previousSize);
    const previousRatio = this.renderer.getPixelRatio();
    const previousAspect = this.camera.aspect;
    const previousPosition = this.camera.position.clone();
    const previousUp = this.camera.up.clone();
    const previousQuaternion = this.camera.quaternion.clone();
    const selected: Array<[LineSegments, boolean]> = [...this.views.values()].map((view) => [
      view.outline,
      view.outline.visible,
    ]);

    try {
      for (const [outline] of selected) outline.visible = false;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(size, size, false);
      this.camera.aspect = 1;

      const target = this.controls.target.clone();
      const distance = this.bedSize * 1.5;
      this.camera.up.set(0, 0, 1);
      this.camera.position.set(
        target.x + distance * 0.55,
        target.y - distance * 0.7,
        distance * 0.62,
      );
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);

      return await new Promise<Blob | null>((resolve) => {
        this.canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    } finally {
      for (const [outline, visible] of selected) outline.visible = visible;
      this.camera.aspect = previousAspect;
      this.camera.position.copy(previousPosition);
      this.camera.up.copy(previousUp);
      this.camera.quaternion.copy(previousQuaternion);
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(previousRatio);
      this.renderer.setSize(previousSize.x, previousSize.y, false);
      this.invalidate();
    }
  }
}

/**
 * A plate preview, rendered off-screen.
 *
 * Deliberately independent of whatever the plater is currently showing: the preview is
 * produced at the moment Slice is pressed, from whichever screen, so it exists even for
 * the "pick a model, press Slice" path where the plater was never opened. It costs one
 * throwaway GL context and about a frame.
 *
 * Returns `null` when the browser has no WebGL — a missing preview is a cosmetic loss,
 * never a reason to fail a slice.
 */
export async function renderPlateThumbnail(
  bed: BedSpec | null,
  instances: readonly Instance[],
  geometries: ReadonlyMap<string, BufferGeometry>,
  size = 512,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  // Off-screen elements report clientWidth 0; the scene reads those for its aspect ratio.
  Object.defineProperty(canvas, 'clientWidth', { value: size });
  Object.defineProperty(canvas, 'clientHeight', { value: size });
  let scene: PlaterScene;
  try {
    scene = new PlaterScene(canvas, { onSelect: () => undefined });
  } catch {
    return null;
  }
  try {
    scene.setBed(bed);
    scene.sync(instances, geometries, null, new Map());
    return await scene.captureThumbnail(size);
  } catch {
    return null;
  } finally {
    scene.dispose();
  }
}
