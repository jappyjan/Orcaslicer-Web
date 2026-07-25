/**
 * Preview: the toolpath in the same viewport the plate was in.
 *
 * The milestone's own words: *"a layer-range slider that loads only the visible window;
 * never hold the whole model in memory on mobile"*, and *"the layer slider stays
 * responsive while scrubbing"*. Both survive the redesign intact — the controller and the
 * window arithmetic are untouched — and the layout makes one of them better:
 *
 *  - **The layer slider is vertical, at the right edge of the free rectangle.** That is
 *    where the desktop build puts it, and on a phone it is the difference between a
 *    350 px slider for 900 layers and an 600 px one. It is still paired with ±1 buttons,
 *    because even at 600 px a thumb cannot address one layer of nine hundred.
 *  - **A second slider says how many layers below the top are drawn.** A single "show
 *    everything up to here" slider — which is what desktop slicers offer — holds the whole
 *    model by the time it reaches the top, which is precisely what the budget forbids.
 *  - **Nothing that reacts to the window is rendered by React.** The window number and its
 *    label are; the geometry is owned by `PreviewController`, off the React tree entirely.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, BedSpec } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import { asApiError } from '../api/http.ts';
import { fetchPreviewIndex } from '../api/preview.ts';
import {
  DEFAULT_WINDOW_LAYERS,
  firstLayer,
  lastLayer,
  layerLabel,
  legendFor,
  toolColours,
  windowFor,
  type ColourMode,
} from '../state/preview.ts';
import type { PreviewStatus } from '../three/preview-controller.ts';
import { Button, ErrorNotice, Spinner, ToolButton } from './primitives.tsx';
import { PreviewPanel, compact } from './PreviewPanel.tsx';
import { FloatingNotice, TitleBlock, Workspace, type Chrome } from './Workspace.tsx';
import { ViewControls } from './PrepareView.tsx';
import type { StageView } from './PlaterStage.tsx';

const PreviewStage = lazy(async () => ({
  default: (await import('./PreviewStage.tsx')).PreviewStage,
}));

export interface PreviewViewProps {
  jobId: string;
  plate?: number;
  /** The plate to draw, and where `extruder_offset` comes from (VERIFIED DEVIATION #15). */
  bed: BedSpec | null;
  onClose: () => void;
  chrome: Chrome;
}

export function PreviewView({ jobId, plate = 1, bed, onClose, chrome }: PreviewViewProps) {
  const [index, setIndex] = useState<PreviewIndex | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [top, setTop] = useState(0);
  const [depth, setDepth] = useState(DEFAULT_WINDOW_LAYERS);
  const [mode, setMode] = useState<ColourMode>('feature');
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const viewRef = useRef<StageView | null>(null);
  const retryRef = useRef<(() => void) | null>(null);

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
        setTop(Math.round((firstLayer(loaded) + lastLayer(loaded)) / 2));
      },
      (cause: unknown) => setError(asApiError(cause)),
    );
  }, [jobId, plate]);

  useEffect(load, [load]);

  const layerWindow = useMemo(
    () => (index ? windowFor(index, top, depth) : null),
    [index, top, depth],
  );
  const legend = useMemo(
    () => (index && layerWindow ? legendFor(index, layerWindow) : []),
    [index, layerWindow],
  );
  const tools = useMemo(() => (index ? toolColours(index) : []), [index]);

  if (!index || !layerWindow) {
    return (
      <div
        className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-ink p-4"
        data-testid="preview"
      >
        {error ? (
          <ErrorNotice error={error} onRetry={load} />
        ) : (
          <>
            <Spinner label="Reading the G-code…" />
            <p className="max-w-xs text-center text-sm text-muted">
              The server compiles the toolpath once per job; a large plate takes a few seconds.
            </p>
          </>
        )}
        <Button variant="secondary" onClick={onClose} testId="preview-back">
          Back to the plate
        </Button>
      </div>
    );
  }

  const bottom = firstLayer(index);
  const ceiling = lastLayer(index);
  const clampedTop = Math.min(ceiling, Math.max(bottom, top));

  return (
    <Workspace
      testId="preview"
      revealSignal={chrome.revealSignal}
      stage={
        webglFailed ? (
          <div className="flex h-full w-full items-center justify-center p-6">
            <p className="max-w-xs text-center text-sm text-muted">
              This browser cannot show 3D, so there is no toolpath to draw.
            </p>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center">
                <Spinner label="Loading the 3D view…" />
              </div>
            }
          >
            <PreviewStage
              jobId={jobId}
              plate={plate}
              index={index}
              bed={bed}
              window={layerWindow}
              mode={mode}
              onStatus={setStatus}
              onWebglFailure={() => setWebglFailed(true)}
              viewRef={viewRef}
              retryRef={retryRef}
            />
          </Suspense>
        )
      }
      title={
        <TitleBlock
          name="G-code preview"
          detail={`${ceiling - bottom + 1} layers · ${compact(index.stats.segments)} segments · plate ${plate}`}
          detailTestId="preview-summary"
        />
      }
      tabs={chrome.tabs}
      status={chrome.status}
      viewControls={<ViewControls viewRef={viewRef} />}
      overlay={
        <>
          {/* The layer slider, down the right-hand edge of whatever the dock is not
              covering. Vertical because layers are vertical, and because a phone has far
              more height to spend on a 900-step control than width. */}
          <div
            className="pointer-events-none absolute z-20 flex flex-col items-end gap-2"
            style={{
              top: 'calc(var(--free-top) + 0.25rem)',
              right: 'calc(var(--free-right) + 0.5rem)',
              bottom: 'calc(var(--free-bottom) + 0.5rem)',
            }}
          >
            <div className="glass pointer-events-auto flex min-h-0 flex-1 flex-col items-center gap-1 rounded-2xl px-1 py-2">
              <StepButton
                label="One layer up"
                caption="+1"
                glyph="chevronUp"
                testId="preview-layer-up"
                onClick={() => setTop((current) => Math.min(ceiling, current + 1))}
              />
              <input
                type="range"
                aria-label="Layer"
                data-testid="preview-layer"
                min={bottom}
                max={ceiling}
                step={1}
                value={clampedTop}
                onChange={(event) => setTop(Number.parseInt(event.target.value, 10))}
                className="range-vertical min-h-24 w-12 flex-1 accent-[color:var(--color-accent)]"
              />
              <StepButton
                label="One layer down"
                caption="−1"
                glyph="chevronDown"
                testId="preview-layer-down"
                onClick={() => setTop((current) => Math.max(bottom, current - 1))}
              />
            </div>
          </div>

          <div
            className="pointer-events-none absolute z-20 flex flex-col items-start gap-2"
            style={{
              left: 'calc(var(--free-left) + 0.5rem)',
              right: 'calc(var(--free-right) + 4.5rem)',
              bottom: 'calc(var(--free-bottom) + 4rem)',
            }}
          >
            <FloatingNotice testId="preview-layer-readout">
              <span className="tabular-nums" data-testid="preview-layer-label">
                {layerLabel(index, clampedTop)}
              </span>
              {status?.loading ? (
                <span className="pulse-soft ml-2 text-muted" data-testid="preview-loading">
                  loading…
                </span>
              ) : null}
            </FloatingNotice>
          </div>
        </>
      }
      dock={
        <>
          {chrome.jobPanel}
          {error ? <ErrorNotice error={error} onRetry={() => setError(null)} /> : null}
          {status?.error ? (
            <ErrorNotice error={status.error} onRetry={() => retryRef.current?.()} />
          ) : null}
          <PreviewPanel
            index={index}
            window={layerWindow}
            depth={depth}
            onDepth={setDepth}
            mode={mode}
            onMode={setMode}
            legend={legend}
            tools={tools}
            status={status}
            bed={bed}
          />
        </>
      }
      dockAction={chrome.action}
    />
  );
}

/** A ±1 layer button: the slider is for "somewhere around there", this is for "that one". */
function StepButton({
  label,
  caption,
  glyph,
  onClick,
  testId,
}: {
  label: string;
  caption: string;
  glyph: 'chevronUp' | 'chevronDown';
  onClick: () => void;
  testId: string;
}) {
  return (
    <ToolButton icon={glyph} label={label} caption={caption} onClick={onClick} testId={testId} />
  );
}
