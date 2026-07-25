/**
 * The G-code preview's WebGL view.
 *
 * ## What it draws, and why in this shape
 *
 * SPEC M5: *"three.js rendering with instanced or merged geometry, one draw call per layer
 * or per feature-type bucket. Not one object per segment."* This is the instanced half of
 * that choice, and the reason is the budget rather than taste:
 *
 *  - **One `InstancedMesh` per layer**, sharing one unit-box geometry and one material.
 *    A window of twenty layers is twenty draw calls, whatever it contains, and a layer
 *    that scrolls out of the window is one `dispose()`.
 *  - **Colour is an instance attribute, not a bucket.** Splitting a layer into
 *    feature-type buckets would also be one draw call each, but there are up to twenty
 *    feature types and switching between "colour by feature" and "colour by tool" would
 *    mean rebuilding every buffer. Here it rewrites 12 bytes per segment and touches no
 *    geometry — which is what makes the mode toggle instant on a phone.
 *  - **The raw bytes are released as soon as a layer is built.** What survives is the
 *    instance matrix (64 B), the instance colour (12 B) and two bytes of feature/tool per
 *    segment, kept only so a recolour need not refetch. ~78 B per segment against the
 *    18 B on the wire; that ratio is exactly why the client holds a window and not a model.
 *
 * ## The coordinate frame, and the 2 mm that hides in it
 *
 * Same frame as the plater (`bed.ts`): millimetres, X right, Y back, Z up, origin at
 * `printable_area`'s origin. But **VERIFIED DEVIATION #15: G-code coordinates are plate
 * coordinates minus `extruder_offset`** — a stock BBL X1C ships `0x2`, so an object
 * centred at y = 120 on the plate extrudes at y = 118 and nothing in the plate description
 * says so; the firmware applies it. The whole toolpath therefore hangs off a group that is
 * translated by `+extruder_offset`, which is both the cheapest place to apply it (once,
 * not per segment) and the hardest place to forget it.
 */

import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BedSpec } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import {
  fallbackWidth,
  featureColour,
  toolColours,
  type ColourMode,
  type LayerWindow,
} from '../state/preview.ts';
import { buildBed, disposeTree, fitDistance, type Insets } from './bed.ts';
import { TouchControls } from './touch-controls.ts';

/** Record layout, mirrored from `packages/gcode/src/format.ts`. */
const U16_STRIDE = 9;
const U8_STRIDE = 18;
const FEATURE_BYTE = 16;
const TOOL_BYTE = 17;

/** `width`/`height` are micrometres in the record and millimetres everywhere else. */
const UM_TO_MM = 0.001;

/** Bytes a built layer costs in JS, per segment: 16 floats + 3 floats + feature + tool. */
export const BYTES_PER_SEGMENT = 64 + 12 + 2;

/**
 * Slowest redraw allowed while a window is still being built.
 *
 * A scrub rebuilds the window several times a second, and every rebuilt layer marks the
 * scene dirty. Drawing each intermediate state at 60 Hz spends the entire frame budget
 * rasterising pictures that are replaced before anyone sees them — and it is the *drawing*,
 * not the building, that dominates: a twenty-layer window is ~280 000 triangles. Ten
 * updates a second is indistinguishable under a moving finger and leaves the gesture its
 * frames. As soon as the window settles the scene goes back to drawing on demand.
 */
const BUILDING_REDRAW_MS = 100;

interface LayerView {
  mesh: InstancedMesh;
  segments: number;
  /** Kept so a colour-mode change never has to refetch or rebuild anything. */
  feature: Uint8Array;
  tool: Uint8Array;
}

export interface PreviewSceneStats {
  layers: number;
  segments: number;
  /** Instance data held in JS, bytes. The GPU holds another copy of the same buffers. */
  instanceBytes: number;
  /** Draw calls in the last frame, straight out of the renderer. */
  drawCalls: number;
}

export class PreviewScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: TouchControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly bedGroup = new Group();
  /** Everything the toolpath is in; translated by `extruder_offset`. */
  private readonly toolpath = new Group();
  private readonly layers = new Map<number, LayerView>();

  /**
   * One geometry and one material for every instance in the scene.
   *
   * The `color` attribute is all-ones and exists only so `vertexColors` can be on: three
   * multiplies `instanceColor` into `vColor`, but the fragment shader applies `vColor` to
   * the surface only under `USE_COLOR`, which is `material.vertexColors`. Without the
   * attribute the shader would read a default of (0,0,0) and draw the whole model black.
   */
  private readonly boxGeometry: BoxGeometry;
  private readonly material: MeshLambertMaterial;

  private index: PreviewIndex | null = null;
  private palette: Color[] = [];
  private toolPalette: Color[] = [];
  private mode: ColourMode = 'feature';
  private fallbackMm = 0.4;
  private bedSize = 256;
  private dirty = true;
  private frame = 0;
  private disposed = false;
  private building = false;
  private lastRender = 0;
  private offsetX = 0;
  private offsetY = 0;
  /** What a fit should get into frame: a centre and the radius of a sphere around it. */
  private readonly fitCentre = new Vector3(128, 128, 0);
  private fitRadius = 160;
  /** How much of the canvas the panels are covering, in CSS pixels. */
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(new Color(0x0b1016), 1);
    this.scene.background = new Color(0x0b1016);

    this.camera = new PerspectiveCamera(45, 1, 1, 4000);
    this.camera.up.set(0, 0, 1);

    this.scene.add(new AmbientLight(0xffffff, 1.6));
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(0.4, -0.8, 1);
    this.scene.add(key);
    const fill = new DirectionalLight(0x93a3b8, 0.7);
    fill.position.set(-0.6, 0.5, 0.4);
    this.scene.add(fill);
    this.scene.add(this.bedGroup);
    this.scene.add(this.toolpath);

    this.boxGeometry = new BoxGeometry(1, 1, 1);
    const vertexCount = this.boxGeometry.getAttribute('position').count;
    this.boxGeometry.setAttribute(
      'color',
      new Float32BufferAttribute(new Float32Array(vertexCount * 3).fill(1), 3),
    );
    this.material = new MeshLambertMaterial({ vertexColors: true });

    this.controls = new TouchControls({
      camera: this.camera,
      element: canvas,
      onChange: () => this.invalidate(),
      // Nothing in a preview is selectable — there is no object, only a toolpath — so a
      // tap is deliberately inert rather than picking a segment nobody can act on.
      onTap: () => undefined,
      minDistance: 20,
      maxDistance: 3000,
    });
    this.controls.frame(new Vector3(128, 128, 20), 420);
    this.resize();
    this.loop();
  }

  // -- lifecycle ------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.clearLayers();
    this.clearBed();
    this.boxGeometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }

  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Tell the scene a layer window is being (re)built, so it can stop drawing every
   * intermediate state. Set by `PreviewController` around a load.
   */
  setBuilding(building: boolean): void {
    this.building = building;
    if (!building) this.invalidate();
  }

  /**
   * Render only when something changed — inherited from the plater, and load-bearing here.
   *
   * A continuous rAF loop that redraws 400 000 triangles sixty times a second for a static
   * picture is a hot phone and a flat battery, and it is also the thing that would make
   * the layer slider stutter: the scrub and the render would be fighting for the same
   * frame budget.
   */
  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    const now = performance.now();
    if (this.building && now - this.lastRender < BUILDING_REDRAW_MS) return;
    this.dirty = false;
    this.lastRender = now;
    this.renderer.render(this.scene, this.camera);
  };

  resize(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    // Capped at 2 for the same reason as the plater: a 3x device pixel ratio triples the
    // fragment cost of every one of those boxes for a difference nobody can see.
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.applyFrameOffset();
    this.fit();
  }

  /**
   * How much of the canvas the floating panels are covering — see `PlaterScene`.
   *
   * The preview needs it more than the plater does: its dock carries the window's legend
   * and byte counts, and the layer slider runs down the free rectangle's right edge, so
   * the toolpath has appreciably less than the full canvas to sit in.
   */
  setViewport(insets: Insets): void {
    this.insets = insets;
    const dx = (insets.left - insets.right) / 2;
    const dy = (insets.top - insets.bottom) / 2;
    if (this.offsetX === dx && this.offsetY === dy) return;
    this.offsetX = dx;
    this.offsetY = dy;
    this.applyFrameOffset();
  }

  private fit(): void {
    this.controls.frame(
      this.fitCentre,
      fitDistance(this.camera, this.canvas, this.insets, this.fitRadius),
    );
  }

  private applyFrameOffset(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    if (this.offsetX === 0 && this.offsetY === 0) {
      this.camera.clearViewOffset();
    } else {
      this.camera.setViewOffset(width, height, -this.offsetX, -this.offsetY, width, height);
    }
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

  setBed(bed: BedSpec | null): void {
    this.clearBed();
    if (bed) {
      const view = buildBed(bed);
      if (view) {
        this.bedGroup.add(view.group);
        this.bedSize = view.size;
      }
    }
    this.invalidate();
  }

  /**
   * VERIFIED DEVIATION #15, in one line.
   *
   * G-code X/Y are plate X/Y *minus* `extruder_offset`, so the group holding the toolpath
   * is translated by *plus* it to put the drawing back where it prints. Applied here
   * rather than per segment: it is one number for the whole plate, and a per-segment
   * version would be 1.5 million additions and one more place to get it wrong.
   */
  setExtruderOffset(offset: readonly [number, number]): void {
    this.toolpath.position.set(offset[0], offset[1], 0);
    this.invalidate();
  }

  // -- the toolpath ---------------------------------------------------------

  setIndex(index: PreviewIndex): void {
    this.clearLayers();
    this.index = index;
    this.fallbackMm = fallbackWidth(index);
    this.palette = index.features.map((_, feature) => new Color().setHex(featureColour(feature)));
    this.toolPalette = toolColours(index).map((hex) => new Color().setHex(hex));
    this.invalidate();
  }

  hasLayer(layer: number): boolean {
    return this.layers.has(layer);
  }

  loadedLayers(): number[] {
    return [...this.layers.keys()];
  }

  /**
   * Turn one layer's records into one `InstancedMesh`.
   *
   * `buffer` is the body of a range request and `recordOffset` is the layer's first record
   * within it. Both views are created over the response buffer with no copy — the record
   * is 18 bytes precisely so that positions, width and height are one `Uint16Array` with a
   * stride of 9 and feature/tool are one `Uint8Array` with a stride of 18 (see
   * docs/GCODE-PREVIEW-FORMAT.md). Nothing here allocates per segment.
   */
  addLayer(layer: number, buffer: ArrayBuffer, recordOffset: number, count: number): void {
    const index = this.index;
    if (!index || count <= 0) return;
    this.removeLayer(layer);

    const byteOffset = recordOffset * U8_STRIDE;
    const u16 = new Uint16Array(buffer, byteOffset, count * U16_STRIDE);
    const u8 = new Uint8Array(buffer, byteOffset, count * U8_STRIDE);

    const [ox, oy, oz] = index.quantisation.origin;
    const [sx, sy, sz] = index.quantisation.scale;
    const fallback = this.fallbackMm;

    const mesh = new InstancedMesh(this.boxGeometry, this.material, count);
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colours = new Float32Array(count * 3);
    mesh.instanceColor = new InstancedBufferAttribute(colours, 3);
    const feature = new Uint8Array(count);
    const tool = new Uint8Array(count);

    for (let i = 0; i < count; i += 1) {
      const q = i * U16_STRIDE;
      const x0 = ox + (u16[q] as number) * sx;
      const y0 = oy + (u16[q + 1] as number) * sy;
      const z0 = oz + (u16[q + 2] as number) * sz;
      const x1 = ox + (u16[q + 3] as number) * sx;
      const y1 = oy + (u16[q + 4] as number) * sy;
      const z1 = oz + (u16[q + 5] as number) * sz;
      // 0 means "the slicer never said" — the prime line runs before the first
      // `; LINE_WIDTH:`. A zero-width box draws nothing at all, so the nozzle stands in.
      const rawWidth = (u16[q + 6] as number) * UM_TO_MM;
      const rawHeight = (u16[q + 7] as number) * UM_TO_MM;
      const width = rawWidth > 0 ? rawWidth : fallback;
      const height = rawHeight > 0 ? rawHeight : fallback;

      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      const length = Math.max(Math.hypot(dx, dy, dz), 1e-4);
      const ux = dx / length;
      const uy = dy / length;
      const uz = dz / length;

      // The box's local X runs along the move, local Y is the horizontal width direction
      // and local Z is the layer height. `cross(dir, worldUp)` gives the width direction;
      // a move that is exactly vertical (a Z-only extrusion) has none, so it falls back to
      // world X rather than producing a NaN matrix and a hole in the picture.
      let rx: number;
      let ry: number;
      const planar = Math.hypot(ux, uy);
      if (planar < 1e-6) {
        rx = 1;
        ry = 0;
      } else {
        rx = uy / planar;
        ry = -ux / planar;
      }
      // up' = right x dir, with right.z == 0.
      const nx = ry * uz;
      const ny = -rx * uz;
      const nz = rx * uy - ry * ux;

      // Column-major, exactly as `Matrix4.elements` and the instance attribute expect.
      const m = i * 16;
      matrices[m] = ux * length;
      matrices[m + 1] = uy * length;
      matrices[m + 2] = uz * length;
      matrices[m + 3] = 0;
      matrices[m + 4] = rx * width;
      matrices[m + 5] = ry * width;
      matrices[m + 6] = 0;
      matrices[m + 7] = 0;
      matrices[m + 8] = nx * height;
      matrices[m + 9] = ny * height;
      matrices[m + 10] = nz * height;
      matrices[m + 11] = 0;
      matrices[m + 12] = (x0 + x1) / 2;
      matrices[m + 13] = (y0 + y1) / 2;
      // The G-code's Z is the *top* of the layer, so the extrusion sits below it.
      matrices[m + 14] = (z0 + z1) / 2 - height / 2;
      matrices[m + 15] = 1;

      const b = i * U8_STRIDE;
      feature[i] = u8[b + FEATURE_BYTE] as number;
      tool[i] = u8[b + TOOL_BYTE] as number;
    }

    const view: LayerView = { mesh, segments: count, feature, tool };
    this.applyColours(view);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = true;
    mesh.name = `layer-${layer}`;
    this.toolpath.add(mesh);
    this.layers.set(layer, view);
    this.invalidate();
  }

  removeLayer(layer: number): void {
    const view = this.layers.get(layer);
    if (!view) return;
    this.toolpath.remove(view.mesh);
    // Frees `instanceMatrix` and `instanceColor` on the GPU. The geometry and material are
    // shared and outlive every layer, so they are deliberately not touched.
    view.mesh.dispose();
    this.layers.delete(layer);
    this.invalidate();
  }

  private clearLayers(): void {
    for (const layer of [...this.layers.keys()]) this.removeLayer(layer);
  }

  /** Colour by feature type or by tool — both, per the brief, as selectable modes. */
  setColourMode(mode: ColourMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const view of this.layers.values()) this.applyColours(view);
    this.invalidate();
  }

  private applyColours(view: LayerView): void {
    const attribute = view.mesh.instanceColor;
    if (!attribute) return;
    const out = attribute.array as Float32Array;
    const source = this.mode === 'tool' ? view.tool : view.feature;
    const palette = this.mode === 'tool' ? this.toolPalette : this.palette;
    const fallback = palette[0] ?? new Color(0xffffff);
    for (let i = 0; i < view.segments; i += 1) {
      const colour = palette[source[i] as number] ?? fallback;
      out[i * 3] = colour.r;
      out[i * 3 + 1] = colour.g;
      out[i * 3 + 2] = colour.b;
    }
    attribute.needsUpdate = true;
  }

  // -- the camera -----------------------------------------------------------

  /**
   * Point the camera at the toolpath rather than at the plate.
   *
   * The bounding box in the index is the *toolpath's*, which on a Bambu includes the
   * 585 mm prime line along the front edge of the bed — so framing it exactly would zoom
   * out to fit a line nobody is looking at. The object's own layers decide the framing,
   * and the plate keeps its usual "1.25x the longest side" fallback.
   */
  frameToolpath(index: PreviewIndex, window: LayerWindow): void {
    const [minX, minY] = index.bounds.min;
    const [maxX, maxY] = index.bounds.max;
    const z = index.layers.z[window.last] ?? index.bounds.max[2];
    const span = Math.max(maxX - minX, maxY - minY, 20);
    this.fitCentre.set(
      (minX + maxX) / 2 + this.toolpath.position.x,
      (minY + maxY) / 2 + this.toolpath.position.y,
      Math.min(z, index.bounds.max[2]) * 0.5,
    );
    this.fitRadius = Math.max(span, this.bedSize * 0.6) * 0.7;
    this.fit();
  }

  /** The camera buttons re-fit as well as re-aim: "3D" and "Top" mean "show me the print". */
  resetView(): void {
    this.controls.reset();
    this.fit();
  }

  topView(): void {
    this.controls.top();
    this.fit();
  }

  // -- accounting -----------------------------------------------------------

  /**
   * World-space bounding box of the layers currently drawn, millimetres.
   *
   * Published by the screen and read by `test/e2e/preview.mjs`, which decodes the same
   * byte range itself and checks the two agree **after** `extruder_offset` — the only way
   * to prove VERIFIED DEVIATION #15 is applied to the geometry rather than merely stored
   * in a field. Half a line width of slack is expected: a segment's box extends ±width/2
   * either side of the centreline the G-code names.
   */
  toolpathBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (this.layers.size === 0) return null;
    this.toolpath.updateMatrixWorld(true);
    const box = new Box3().setFromObject(this.toolpath, true);
    if (box.isEmpty()) return null;
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
  }

  stats(): PreviewSceneStats {
    let segments = 0;
    for (const view of this.layers.values()) segments += view.segments;
    return {
      layers: this.layers.size,
      segments,
      instanceBytes: segments * BYTES_PER_SEGMENT,
      drawCalls: this.renderer.info.render.calls,
    };
  }
}
