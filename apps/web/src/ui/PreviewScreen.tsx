/**
 * The G-code preview screen (M5, client side).
 *
 * The milestone's own words: *"a layer-range slider that loads only the visible window;
 * never hold the whole model in memory on mobile"*, and *"the layer slider stays
 * responsive while scrubbing"*. Everything on this screen is shaped by those two:
 *
 *  - **Two sliders, not one.** The first says which layer you are looking at; the second
 *    says how many layers below it are drawn. A single "show everything up to here"
 *    slider — which is what desktop slicers offer — holds the whole model by the time it
 *    reaches the top, which is precisely the thing the budget forbids.
 *  - **A pair of ±1 buttons next to the layer slider.** On a 390 px screen a slider is
 *    ~350 px for ~900 layers: two or three layers per pixel, so a thumb cannot address a
 *    single one. The slider is for "somewhere around there" and the buttons are for
 *    "that one", the same argument the plater makes for its slider-plus-field fields.
 *  - **Nothing that reacts to the window is rendered by React.** The window number and its
 *    label are; the geometry is owned by `PreviewController`, off the React tree entirely.
 *
 * The status line carries its numbers as `data-` attributes because the acceptance test
 * (`test/e2e/preview.mjs`) reads them: "twenty layers are on screen" and "the window is
 * 600 KB" are claims that should be measured rather than eyeballed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, BedSpec } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import { asApiError } from '../api/http.ts';
import { fetchPreviewIndex } from '../api/preview.ts';
import {
  DEFAULT_WINDOW_LAYERS,
  MAX_WINDOW_LAYERS,
  firstLayer,
  formatBytesShort,
  lastLayer,
  layerLabel,
  legendFor,
  toolColours,
  windowFor,
  type ColourMode,
} from '../state/preview.ts';
import { PreviewScene } from '../three/preview-scene.ts';
import { PreviewController, type PreviewStatus } from '../three/preview-controller.ts';
import { Button, ErrorNotice, Spinner } from './primitives.tsx';

export interface PreviewScreenProps {
  jobId: string;
  plate?: number;
  /** The plate to draw, and where `extruder_offset` comes from (VERIFIED DEVIATION #15). */
  bed: BedSpec | null;
  onClose: () => void;
}

export function PreviewScreen({ jobId, plate = 1, bed, onClose }: PreviewScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PreviewScene | null>(null);
  const controllerRef = useRef<PreviewController | null>(null);

  const [index, setIndex] = useState<PreviewIndex | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [top, setTop] = useState(0);
  const [depth, setDepth] = useState(DEFAULT_WINDOW_LAYERS);
  const [mode, setMode] = useState<ColourMode>('feature');
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  /** The opening window's depth, readable from the scene effect without re-binding it. */
  const depthRef = useRef(depth);
  depthRef.current = depth;

  // -- the index ------------------------------------------------------------
  // One JSON document for the whole session: 23 KB for a 900-layer model, immutable, and
  // it is what every byte range below is computed from. The server compiles the preview
  // on this request, which for a 42 MiB plate is a couple of seconds — hence the spinner.
  const load = useCallback(() => {
    setError(null);
    fetchPreviewIndex(jobId, plate).then(
      (loaded) => {
        setIndex(loaded);
        // Open in the middle of the print rather than at the top: the top layer of a solid
        // object is a featureless lid, and the middle is where walls, infill and supports
        // are all visible at once.
        const bottom = firstLayer(loaded);
        setTop(Math.round((bottom + lastLayer(loaded)) / 2));
      },
      (cause: unknown) => setError(asApiError(cause)),
    );
  }, [jobId, plate]);

  useEffect(load, [load]);

  // -- the scene ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !index) return;
    let scene: PreviewScene;
    try {
      scene = new PreviewScene(canvas);
    } catch (cause) {
      setWebglFailed(true);
      setError(asApiError(cause));
      return;
    }
    sceneRef.current = scene;
    scene.setBed(bed);
    // VERIFIED DEVIATION #15: G-code X/Y are plate X/Y minus `extruder_offset`. Without
    // this the whole toolpath sits 2 mm off the objects it belongs to on a stock X1C.
    scene.setExtruderOffset(bed?.extruderOffset ?? [0, 0]);
    scene.setIndex(index);

    const start = windowFor(
      index,
      Math.round((firstLayer(index) + lastLayer(index)) / 2),
      depthRef.current,
    );
    scene.frameToolpath(index, start);
    const controller = new PreviewController(scene, jobId, plate, index, start, setStatus);
    controllerRef.current = controller;

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      controller.dispose();
      controllerRef.current = null;
      sceneRef.current = null;
      scene.dispose();
    };
    // Built once per index. The opening depth is read through a ref rather than taken as a
    // dependency, because changing it must move the window, not tear down a GL context.
  }, [index, jobId, plate, bed]);

  // -- the window -----------------------------------------------------------

  const window_ = useMemo(() => (index ? windowFor(index, top, depth) : null), [index, top, depth]);

  useEffect(() => {
    if (window_) controllerRef.current?.setWindow(window_);
  }, [window_]);

  useEffect(() => {
    controllerRef.current?.setColourMode(mode);
  }, [mode]);

  const legend = useMemo(
    () => (index && window_ ? legendFor(index, window_) : []),
    [index, window_],
  );
  const tools = useMemo(() => (index ? toolColours(index) : []), [index]);

  // -- render ---------------------------------------------------------------

  if (error && !index) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col gap-4 bg-ink p-4" data-testid="preview">
        <ErrorNotice error={error} onRetry={load} />
        <Button variant="secondary" onClick={onClose} testId="preview-back">
          Back
        </Button>
      </div>
    );
  }

  if (!index) {
    return (
      <div
        className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-ink p-4"
        data-testid="preview"
      >
        <Spinner label="Reading the G-code…" />
        <p className="max-w-xs text-center text-sm text-muted">
          The server compiles the toolpath once per job; a large plate takes a few seconds.
        </p>
        <Button variant="secondary" onClick={onClose} testId="preview-back">
          Back
        </Button>
      </div>
    );
  }

  const bottom = firstLayer(index);
  const ceiling = lastLayer(index);
  const shown = window_ ?? { first: bottom, last: bottom };
  const clampedTop = Math.min(ceiling, Math.max(bottom, top));

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink" data-testid="preview">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          data-testid="preview-back"
          className="tap rounded-lg px-3 text-base text-accent active:bg-surface-2"
        >
          ‹ Back
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-base font-semibold">
          G-code preview
          <span className="block truncate text-xs text-muted" data-testid="preview-summary">
            {`${ceiling - bottom + 1} layers · ${compact(index.stats.segments)} segments · plate ${plate}`}
          </span>
        </h2>
      </header>

      <div className="relative h-[38vh] min-h-[220px] shrink-0 border-b border-line">
        <canvas
          ref={canvasRef}
          data-testid="preview-canvas"
          className="block h-full w-full"
          aria-label="G-code toolpath"
        />
        {webglFailed ? (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted">
            This browser cannot show 3D, so there is no toolpath to draw.
          </p>
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between p-2 text-[11px] text-muted">
          <span>Drag to turn · two fingers to pan and zoom</span>
        </div>
        <div className="absolute top-2 right-2 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => sceneRef.current?.topView()}
            className="tap rounded-lg border border-line bg-surface/90 px-3 text-sm text-text active:bg-surface-2"
          >
            Top
          </button>
          <button
            type="button"
            onClick={() => sceneRef.current?.resetView()}
            className="tap rounded-lg border border-line bg-surface/90 px-3 text-sm text-text active:bg-surface-2"
          >
            3D
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-3 py-3">
        {error ? <ErrorNotice error={error} onRetry={() => setError(null)} /> : null}
        {status?.error ? (
          <ErrorNotice error={status.error} onRetry={() => controllerRef.current?.retry()} />
        ) : null}

        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm text-text" data-testid="preview-layer-label">
              {layerLabel(index, clampedTop)}
            </p>
            {status?.loading ? (
              <span className="pulse-soft text-xs text-muted" data-testid="preview-loading">
                loading…
              </span>
            ) : null}
          </div>
          <input
            type="range"
            aria-label="Layer"
            data-testid="preview-layer"
            min={bottom}
            max={ceiling}
            step={1}
            value={clampedTop}
            onChange={(event) => setTop(Number.parseInt(event.target.value, 10))}
            className="mt-1 h-12 w-full accent-[color:var(--color-accent)]"
          />
          <div className="grid grid-cols-2 gap-2">
            <StepButton
              label="− 1 layer"
              testId="preview-layer-down"
              onClick={() => setTop((current) => Math.max(bottom, current - 1))}
            />
            <StepButton
              label="+ 1 layer"
              testId="preview-layer-up"
              onClick={() => setTop((current) => Math.min(ceiling, current + 1))}
            />
          </div>
        </div>

        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-sm text-text">
            Layers shown:{' '}
            <span className="tabular-nums" data-testid="preview-depth-label">
              {shown.last - shown.first + 1}
            </span>
          </p>
          <input
            type="range"
            aria-label="Layers shown"
            data-testid="preview-depth"
            min={1}
            max={MAX_WINDOW_LAYERS}
            step={1}
            value={depth}
            onChange={(event) => setDepth(Number.parseInt(event.target.value, 10))}
            className="mt-1 h-11 w-full accent-[color:var(--color-accent)]"
          />
          <p className="text-xs text-muted">
            Only these layers are downloaded and held; everything else is released.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Colour by">
          {(['feature', 'tool'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={mode === candidate}
              data-testid={`preview-colour-${candidate}`}
              onClick={() => setMode(candidate)}
              className={`tap rounded-xl border px-2 text-base capitalize transition-colors ${
                mode === candidate
                  ? 'border-accent bg-accent text-accent-ink font-semibold'
                  : 'border-line bg-surface-2 text-text active:bg-line'
              }`}
            >
              {candidate === 'feature' ? 'By feature' : 'By tool'}
            </button>
          ))}
        </div>

        <div
          className="flex flex-wrap gap-x-3 gap-y-1 rounded-xl border border-line bg-surface p-3"
          data-testid="preview-legend"
        >
          {mode === 'feature'
            ? legend.map((entry) => (
                <Swatch key={entry.feature} colour={entry.colour} label={entry.name} />
              ))
            : tools.map((colour, slot) => (
                <Swatch key={slot} colour={colour} label={`Tool ${slot + 1}`} />
              ))}
          {mode === 'feature' && legend.length === 0 ? (
            <span className="text-xs text-muted">No extrusions in this window.</span>
          ) : null}
        </div>

        <p
          className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-muted tabular-nums"
          data-testid="preview-stats"
          data-first={shown.first}
          data-last={shown.last}
          data-loaded={status?.loaded ?? 0}
          data-segments={status?.segments ?? 0}
          data-bytes={status?.bytes ?? 0}
          data-instance-bytes={status?.instanceBytes ?? 0}
          data-first-paint-ms={
            status?.firstPaintMs === null ? '' : Math.round(status?.firstPaintMs ?? 0)
          }
          data-extruder-offset={(bed?.extruderOffset ?? [0, 0]).join(',')}
          data-world={status?.bounds ? [...status.bounds.min, ...status.bounds.max].join(',') : ''}
        >
          {`layers ${shown.first}–${shown.last} · ${compact(status?.segments ?? 0)} segments · ` +
            `${formatBytesShort(status?.bytes ?? 0)} fetched · ` +
            `${formatBytesShort(status?.instanceBytes ?? 0)} on the GPU`}
        </p>

        {bed === null ? (
          <p className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
            No printer is selected, so the plate and its extruder offset are unknown. The toolpath
            may sit a couple of millimetres from where it prints.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="tap w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-text transition-colors active:bg-line"
    >
      {label}
    </button>
  );
}

function Swatch({ colour, label }: { colour: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span
        aria-hidden
        className="inline-block h-3 w-3 shrink-0 rounded-sm"
        style={{ background: `#${colour.toString(16).padStart(6, '0')}` }}
      />
      {label}
    </span>
  );
}

function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
