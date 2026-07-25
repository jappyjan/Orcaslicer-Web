/**
 * Progress, then results.
 *
 * The progress half is built around SPEC verified deviation #10 and the measurement that
 * confirmed it for this milestone: a 20 mm cube produced **two** progress frames, the
 * first at **70 %**. So:
 *
 *  - before the first number the bar is an indeterminate sweep, never a 0 % bar;
 *  - after a {@link QUIET_AFTER_MS} gap it keeps animating and says the slicer is still
 *    working, because with nine frames per job a long silence is normal;
 *  - the percentage is only rendered once it means something;
 *  - warnings appear the moment they arrive and stay on the results panel afterwards.
 *
 * The results half shows exactly what the spec asks for — time, grams, metres, layer
 * count — and offers both downloads, because Bambu printers want the `.gcode.3mf`
 * project file while everything else wants the plain `.gcode`.
 */

import type { ArtifactSummary, JobSummary, SliceStats } from '@orca-web/shared';
import { artifactUrl } from '../api/jobs.ts';
import {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatGrams,
  formatMetres,
} from '../format.ts';
import { barState, isActive, isQuiet, type ProgressModel } from '../state/progress.ts';
import { Button, ErrorNotice, WarningList } from './primitives.tsx';

const STATE_LABELS: Record<string, string> = {
  submitting: 'Sending to the slicer',
  queued: 'Waiting for a slot',
  running: 'Slicing',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted by a server restart',
};

/**
 * How far the plate preview has got (M4).
 *
 * The slicer cannot render one — it needs OpenGL and the container has no display server
 * — so the plater's WebGL view renders it and it is written into the `.gcode.3mf` after
 * the slice finishes (SPEC deviation #5: with `--min-save` the archive has no
 * `Metadata/plate_N.png` at all). Downloading a second earlier would fetch the archive
 * without it, so the state is shown rather than hidden.
 */
export type PreviewState = 'none' | 'uploading' | 'done' | 'failed';

export function JobScreen({
  model,
  progress,
  now,
  onCancel,
  onSliceAgain,
  onBack,
  cancelling,
  preview = 'none',
}: {
  model: ProgressModel;
  progress: { name: string; subtitle: string };
  now: number;
  onCancel: () => void;
  onSliceAgain: () => void;
  onBack: () => void;
  cancelling: boolean;
  preview?: PreviewState;
}) {
  const active = isActive(model);
  const quiet = isQuiet(model, now);
  const bar = barState(model);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col">
      <header className="px-4 pt-4 pb-2">
        <h1 className="truncate text-xl font-semibold">{progress.name}</h1>
        <p className="truncate text-sm text-muted">{progress.subtitle}</p>
      </header>

      <main className="flex-1 space-y-4 px-4 pb-4">
        <section
          className="rounded-xl border border-line bg-surface p-4"
          aria-live="polite"
          data-testid="progress-panel"
          data-bar-state={bar}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-base font-semibold" data-testid="job-state">
              {STATE_LABELS[model.state] ?? model.state}
            </p>
            {bar === 'determinate' || bar === 'complete' ? (
              <p className="text-base tabular-nums text-accent" data-testid="job-percent">
                {Math.round(model.percent)}%
              </p>
            ) : null}
          </div>

          <ProgressBar state={bar} percent={model.percent} />

          <p className="mt-2 text-sm text-muted" data-testid="job-message">
            {model.message ??
              (model.state === 'queued'
                ? 'Another job is using the slicer.'
                : 'Preparing the sandbox…')}
          </p>

          {model.plateCount > 1 ? (
            <p className="mt-1 text-sm text-muted">
              Plate {Math.max(1, model.plateIndex)} of {model.plateCount}
            </p>
          ) : null}

          {/*
            A gap in the stream is normal — the pipe emits ~9 lines per job — so this is
            reassurance, not a warning. Without it a 20-second silence looks like a hang.
          */}
          {quiet ? (
            <p className="mt-2 text-sm text-warn" data-testid="job-quiet">
              Still working. OrcaSlicer only reports progress a handful of times per job.
            </p>
          ) : null}

          {model.degraded ? (
            <p className="mt-2 text-sm text-muted" data-testid="job-degraded">
              Live updates dropped out; checking every few seconds instead.
            </p>
          ) : null}

          {active ? (
            <p className="mt-2 text-sm text-muted tabular-nums">
              {formatElapsed(now - model.startedAt)} elapsed
            </p>
          ) : null}
        </section>

        <WarningList warnings={model.warnings} />

        {model.error ? <ErrorNotice error={model.error} testId="job-error" /> : null}

        {model.job ? <Results job={model.job} preview={preview} /> : null}
      </main>

      <footer className="sticky bottom-0 space-y-2 border-t border-line bg-ink/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        {active ? (
          <Button variant="danger" onClick={onCancel} disabled={cancelling} testId="cancel-button">
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        ) : (
          <>
            <Button onClick={onSliceAgain} testId="slice-again-button">
              Slice again
            </Button>
            <Button variant="secondary" onClick={onBack} testId="back-button">
              Change settings
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}

function ProgressBar({
  state,
  percent,
}: {
  state: 'indeterminate' | 'determinate' | 'complete';
  percent: number;
}) {
  return (
    <div
      className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-label="Slicing progress"
      {...(state === 'indeterminate'
        ? {}
        : { 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 })}
    >
      {state === 'indeterminate' ? (
        <div className="bar-indeterminate h-full w-1/3 rounded-full bg-accent" />
      ) : (
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            state === 'complete' ? 'bg-ok' : 'bg-accent'
          }`}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      )}
    </div>
  );
}

function Results({ job, preview }: { job: JobSummary; preview: PreviewState }) {
  const stats = job.stats;
  return (
    <>
      {stats ? <StatsPanel stats={stats} /> : null}
      <Downloads jobId={job.id} artifacts={job.artifacts} preview={preview} />
    </>
  );
}

function StatsPanel({ stats }: { stats: SliceStats }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4" data-testid="results-stats">
      <h2 className="mb-3 text-xs tracking-wide text-muted uppercase">Result</h2>
      <dl className="grid grid-cols-2 gap-3">
        <Stat
          label="Print time"
          value={formatDuration(stats.predictionSeconds)}
          testId="stat-time"
        />
        <Stat label="Material" value={formatGrams(stats.weightGrams)} testId="stat-grams" />
        <Stat label="Filament" value={formatMetres(stats.totalMetres)} testId="stat-metres" />
        <Stat
          label="Layers"
          value={stats.layerCount === null ? '—' : String(stats.layerCount)}
          testId="stat-layers"
        />
      </dl>

      {stats.plates.length > 1 ? (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs tracking-wide text-muted uppercase">Per plate</h3>
          {stats.plates.map((plate) => (
            <p key={plate.index} className="text-sm text-muted">
              Plate {plate.index}: {formatDuration(plate.predictionSeconds)} ·{' '}
              {formatGrams(plate.weightGrams)}
              {plate.layerCount === null ? '' : ` · ${plate.layerCount} layers`}
              {plate.supportUsed ? ' · supports' : ''}
              {plate.outside ? ' · outside the bed' : ''}
            </p>
          ))}
        </div>
      ) : null}

      {stats.plates[0] && stats.plates[0].filaments.length > 0 ? (
        <div className="mt-4 space-y-1">
          <h3 className="text-xs tracking-wide text-muted uppercase">Filament use</h3>
          {stats.plates.flatMap((plate) =>
            plate.filaments.map((filament) => (
              <p key={`${plate.index}-${filament.id}`} className="text-sm text-muted">
                Slot {filament.id}
                {filament.type ? ` · ${filament.type}` : ''} · {formatMetres(filament.usedMetres)} ·{' '}
                {formatGrams(filament.usedGrams)}
              </p>
            )),
          )}
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

const ARTIFACT_LABELS: Record<ArtifactSummary['role'], (artifact: ArtifactSummary) => string> = {
  project: () => 'Project file (.gcode.3mf)',
  gcode: (artifact) => (artifact.plate === undefined ? 'G-code' : `Plate ${artifact.plate} G-code`),
};

const PREVIEW_LABELS: Record<PreviewState, string | null> = {
  none: null,
  uploading: 'Adding the plate preview to the project file…',
  done: 'Plate preview included.',
  failed: 'The plate preview could not be added; the G-code is unaffected.',
};

function Downloads({
  jobId,
  artifacts,
  preview,
}: {
  jobId: string;
  artifacts: readonly ArtifactSummary[];
  preview: PreviewState;
}) {
  if (artifacts.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-surface p-4" data-testid="downloads">
      <h2 className="mb-1 text-xs tracking-wide text-muted uppercase">Download</h2>
      <p className="mb-3 text-sm text-muted">
        Bambu Lab printers want the project file; most others want the plain G-code.
      </p>
      {PREVIEW_LABELS[preview] ? (
        <p
          className="mb-3 text-sm text-muted"
          data-testid="preview-status"
          data-state={preview}
          role="status"
        >
          {PREVIEW_LABELS[preview]}
        </p>
      ) : null}
      <ul className="space-y-2">
        {artifacts.map((artifact) => (
          <li key={artifact.name}>
            <a
              href={artifactUrl(jobId, artifact.name)}
              download={artifact.name}
              data-testid={`download-${artifact.role}`}
              className="tap flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3 text-base transition-colors active:bg-line"
            >
              <span className="min-w-0 flex-1 truncate">
                {ARTIFACT_LABELS[artifact.role](artifact)}
              </span>
              <span className="shrink-0 text-sm text-muted tabular-nums">
                {formatBytes(artifact.bytes)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
