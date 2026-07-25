/**
 * The preview's controls, minus the one that moved.
 *
 * The layer slider itself now runs down the right-hand edge of the viewport — where
 * OrcaSlicer's desktop build puts it, and where a thumb can reach it without covering the
 * thing it is scrubbing. What is left here is everything that is read rather than dragged:
 * how deep the window is, what the colours mean, and what the window is costing.
 *
 * The status line carries its numbers as `data-` attributes because the acceptance test
 * (`test/e2e/preview.mjs`) reads them: "twenty layers are on screen" and "the window is
 * 600 KB" are claims that should be measured rather than eyeballed.
 */

import type { BedSpec } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import {
  MAX_WINDOW_LAYERS,
  formatBytesShort,
  type ColourMode,
  type LayerWindow,
  type LegendEntry,
} from '../state/preview.ts';
import type { PreviewStatus } from '../three/preview-controller.ts';
import { Panel, Segmented } from './primitives.tsx';

export function PreviewPanel({
  index,
  window: shown,
  depth,
  onDepth,
  mode,
  onMode,
  legend,
  tools,
  status,
  bed,
}: {
  index: PreviewIndex;
  window: LayerWindow;
  depth: number;
  onDepth: (depth: number) => void;
  mode: ColourMode;
  onMode: (mode: ColourMode) => void;
  legend: readonly LegendEntry[];
  tools: readonly number[];
  status: PreviewStatus | null;
  bed: BedSpec | null;
}) {
  return (
    <Panel title="Toolpath" testId="preview-panel">
      <div className="space-y-2 rounded-xl border border-line bg-surface p-3">
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
          onChange={(event) => onDepth(Number.parseInt(event.target.value, 10))}
          className="h-11 w-full accent-[color:var(--color-accent)]"
        />
        <p className="text-xs text-muted">
          Only these layers are downloaded and held; everything else is released.
        </p>
      </div>

      <Segmented
        label="Colour by"
        testIdPrefix="preview-colour"
        value={mode}
        onChange={onMode}
        options={[
          { value: 'feature', label: 'By feature' },
          { value: 'tool', label: 'By tool' },
        ]}
      />

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
        className="rounded-xl border border-line bg-surface px-3 py-2.5 text-xs text-muted tabular-nums"
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
        data-total-layers={index.stats.layers}
      >
        {`layers ${shown.first}–${shown.last} · ${compact(status?.segments ?? 0)} segments · ` +
          `${formatBytesShort(status?.bytes ?? 0)} fetched · ` +
          `${formatBytesShort(status?.instanceBytes ?? 0)} on the GPU`}
      </p>

      {bed === null ? (
        <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-warn">
          No printer is selected, so the plate and its extruder offset are unknown. The toolpath may
          sit a couple of millimetres from where it prints.
        </p>
      ) : null}
    </Panel>
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

export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
