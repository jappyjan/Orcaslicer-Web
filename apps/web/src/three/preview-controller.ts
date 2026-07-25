/**
 * What keeps the layer slider responsive.
 *
 * The renderer (`preview-scene.ts`) knows how to turn bytes into boxes. This owns the much
 * harder question of *which* bytes, and it is deliberately outside React: a scrub is sixty
 * window changes a second, and anything that put geometry into component state would
 * re-render the tree on every one of them.
 *
 * Three rules, and each of them is the answer to a way the slider stops feeling live:
 *
 *  1. **Only the missing layers are fetched.** A window that shifts by one layer is one
 *     one-layer range request, not a fresh twenty-layer download. `missingRuns()` does the
 *     set arithmetic; contiguous runs mean one HTTP request each.
 *  2. **The newest layer is fetched first, and an obsolete fetch is aborted.** While a
 *     finger is dragging, the run nearest the top of the window is the one being looked
 *     at; a request for a window the user has already left is cancelled rather than
 *     allowed to finish and stall the one that matters.
 *  3. **Building is time-sliced.** Turning 30 000 segments into instance matrices is a few
 *     milliseconds, and a deep window is a few tens; done in one go it is a dropped frame
 *     in the middle of a gesture. The loop yields to `requestAnimationFrame` every
 *     {@link BUILD_SLICE_MS}, so the browser always gets its frame.
 *
 * Eviction happens *before* the fetch, not after, so the peak is one window rather than
 * two — which is the difference between the budget and twice the budget on a phone.
 */

import type { ApiError } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import { asApiError } from '../api/http.ts';
import { fetchLayerBytes } from '../api/preview.ts';
import {
  byteRange,
  evictable,
  missingRuns,
  windowSegments,
  type ColourMode,
  type LayerWindow,
} from '../state/preview.ts';
import type { PreviewScene } from './preview-scene.ts';

/** How long the build loop may hold the main thread before yielding a frame. */
const BUILD_SLICE_MS = 8;

/**
 * A drag produces a window change per pointer event — sixty a second.
 *
 * This is a **throttle, not a debounce**, and the difference is the whole feel of the
 * control. A debounce (reset the timer on every change) would show nothing at all until
 * the finger stopped, which is a scrub with no feedback. Throttling instead loads the
 * newest window about twenty times a second while the drag is still happening, and the
 * windows passed through in between are simply never requested.
 */
const SCRUB_THROTTLE_MS = 50;

export interface PreviewStatus {
  window: LayerWindow;
  /** Segments the current window contains, from the index — known before anything loads. */
  segments: number;
  /** Bytes the current window spans in the `.bin`. */
  bytes: number;
  loading: boolean;
  /** Layers actually built and on the GPU. */
  loaded: number;
  /** Instance data held in JS. The GPU holds another copy. */
  instanceBytes: number;
  /** Milliseconds from construction to the first layer appearing. */
  firstPaintMs: number | null;
  /**
   * World-space bounding box of what is drawn, once the window has settled.
   *
   * Only computed when nothing is loading: it walks every instance of every new layer, and
   * doing that mid-scrub would put an O(segments) pass inside the gesture it is meant to
   * keep smooth.
   */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  error: ApiError | null;
}

export class PreviewController {
  private readonly scene: PreviewScene;
  private readonly jobId: string;
  private readonly plate: number;
  private readonly index: PreviewIndex;
  private readonly onStatus: (status: PreviewStatus) => void;
  private readonly createdAt = performance.now();

  private target: LayerWindow;
  private running = false;
  private disposed = false;
  private inFlight: { run: LayerWindow; abort: AbortController } | null = null;
  private throttle: ReturnType<typeof setTimeout> | undefined;
  private firstPaintMs: number | null = null;
  private error: ApiError | null = null;

  constructor(
    scene: PreviewScene,
    jobId: string,
    plate: number,
    index: PreviewIndex,
    initial: LayerWindow,
    onStatus: (status: PreviewStatus) => void,
  ) {
    this.scene = scene;
    this.jobId = jobId;
    this.plate = plate;
    this.index = index;
    this.target = initial;
    this.onStatus = onStatus;
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.throttle !== undefined) clearTimeout(this.throttle);
    this.inFlight?.abort.abort();
    this.inFlight = null;
  }

  /**
   * Ask for a window. Cheap and idempotent — safe to call from a slider's `onChange`.
   *
   * The scene is *not* touched here: layers already loaded stay visible while the new ones
   * arrive, so dragging the slider never flashes an empty plate.
   */
  setWindow(window: LayerWindow): void {
    if (window.first === this.target.first && window.last === this.target.last) return;
    this.target = window;
    // Abort a fetch for layers the new window no longer wants; keep one that is still
    // useful, because a slow connection would otherwise never finish anything.
    const run = this.inFlight?.run;
    if (run && (run.last < window.first || run.first > window.last)) {
      this.inFlight?.abort.abort();
      this.inFlight = null;
    }
    this.report();
    this.schedule(SCRUB_THROTTLE_MS);
  }

  setColourMode(mode: ColourMode): void {
    this.scene.setColourMode(mode);
  }

  retry(): void {
    this.error = null;
    this.schedule(0);
  }

  /**
   * Arm the loader, at most once per throttle interval.
   *
   * A pending timer is deliberately left alone rather than pushed back: pushing it back is
   * what turns this into a debounce, and a debounce never fires at all while a finger keeps
   * moving. Whenever it does fire it reads `this.target`, which is always the newest window.
   */
  private schedule(delay: number): void {
    if (this.disposed || this.throttle !== undefined) return;
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      void this.run();
    }, delay);
  }

  private report(): void {
    if (this.disposed) return;
    const stats = this.scene.stats();
    const range = byteRange(this.index, this.target);
    this.onStatus({
      window: this.target,
      segments: windowSegments(this.index, this.target),
      bytes: range?.length ?? 0,
      loading: this.running,
      loaded: stats.layers,
      instanceBytes: stats.instanceBytes,
      firstPaintMs: this.firstPaintMs,
      bounds: this.running ? null : this.scene.toolpathBounds(),
      error: this.error,
    });
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed || this.error) return;
    this.running = true;
    // While the window is moving the scene draws at a tenth of the frame rate: the frames
    // saved are the ones the gesture needs, and nobody sees a picture that is replaced
    // 16 ms later anyway.
    this.scene.setBuilding(true);
    this.report();
    try {
      // Re-read `this.target` every pass: the finger may have moved while the last range
      // request was in the air, and the loop should chase the newest window, not finish
      // servicing an old one.
      for (let guard = 0; guard < 512 && !this.disposed; guard += 1) {
        const target = this.target;
        this.evict(target);
        const runs = this.pendingRuns(target);
        if (runs.length === 0) break;
        await this.load(runs[0] as LayerWindow);
      }
    } catch (cause) {
      if (!isAbort(cause)) this.error = asApiError(cause);
    } finally {
      this.running = false;
      this.scene.setBuilding(false);
      this.report();
      // The window can have moved in the microseconds between the loop deciding it had
      // nothing left to do and this line. Without the re-arm, a finger that stopped at
      // exactly that moment would leave the last window it chose unloaded.
      if (!this.disposed && !this.error && this.pendingRuns(this.target).length > 0) {
        this.schedule(0);
      }
    }
  }

  /** Drop layers outside the window *first*, so peak memory is one window and not two. */
  private evict(target: LayerWindow): void {
    for (const layer of evictable(target, this.scene.loadedLayers())) {
      this.scene.removeLayer(layer);
    }
  }

  /**
   * Missing runs, nearest the top of the window first.
   *
   * The top layer is the one the slider is pointing at and the one the user is looking
   * for, so it should appear before the twenty beneath it — that is what makes a jump
   * across the model feel immediate rather than "wait, then everything".
   */
  private pendingRuns(target: LayerWindow): LayerWindow[] {
    const have = new Set(this.scene.loadedLayers());
    // An empty layer produces no mesh, so it would never become "loaded" and the loop
    // would ask for it for ever. It counts as satisfied because there is nothing to draw.
    for (let layer = target.first; layer <= target.last; layer += 1) {
      if ((this.index.layers.count[layer] ?? 0) === 0) have.add(layer);
    }
    const runs = missingRuns(target, have);
    runs.sort((a, b) => b.last - a.last);
    return runs;
  }

  private async load(run: LayerWindow): Promise<void> {
    const range = byteRange(this.index, run);
    if (!range) return;
    const abort = new AbortController();
    this.inFlight = { run, abort };
    let buffer: ArrayBuffer;
    try {
      buffer = await fetchLayerBytes(this.jobId, this.plate, range.start, range.end, abort.signal);
    } finally {
      if (this.inFlight?.abort === abort) this.inFlight = null;
    }
    if (this.disposed) return;

    // Chunks are contiguous and in order, so the cursor walks `count` records per layer
    // from the start of the response body — no per-layer offsets are needed and no copy
    // is made (docs/GCODE-PREVIEW-FORMAT.md, "Fetching a layer window").
    let cursor = 0;
    let sliceStart = performance.now();
    let lastReport = sliceStart;
    for (let layer = run.first; layer <= run.last; layer += 1) {
      const count = this.index.layers.count[layer] ?? 0;
      // `this.target`, not the window this run was chosen for: the finger may have moved
      // while the bytes were in the air, and a layer nobody is looking at any more is not
      // worth building. It stays in the browser's cache if the user comes back.
      const target = this.target;
      if (layer >= target.first && layer <= target.last && !this.scene.hasLayer(layer)) {
        this.scene.addLayer(layer, buffer, cursor, count);
        if (this.firstPaintMs === null) {
          this.firstPaintMs = performance.now() - this.createdAt;
        }
      }
      cursor += count;
      const now = performance.now();
      if (now - sliceStart > BUILD_SLICE_MS) {
        // Reported at ten a second rather than at every yield: the status line is a caption,
        // and re-rendering React 120 times a second to update it would be spending the
        // frames this loop exists to protect.
        if (now - lastReport > 100) {
          lastReport = now;
          this.report();
        }
        await nextFrame();
        if (this.disposed) return;
        sliceStart = performance.now();
      }
    }
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}
