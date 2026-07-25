/**
 * The one screen you see before slicing: five choices in the order the catalog can
 * answer them, and a button.
 *
 * Printer → nozzle → process + filament is not a stylistic ordering. `/catalog/presets`
 * needs a model *and* a nozzle before it can say which process and filament presets are
 * valid, so the rows below the nozzle stay disabled until it is chosen — and the nozzle
 * list comes from `nozzleVariants`, never from `advertisedNozzleDiameters`, which
 * advertises diameters that have no machine preset behind them.
 */

import type { ApiError } from '@orca-web/shared';
import { formatBytes } from '../format.ts';
import type { Catalog } from '../api/catalog.ts';
import { missingStep, type Selection } from '../state/selection.ts';
import { Button, ErrorNotice, Row } from './primitives.tsx';

export type SheetName = 'model' | 'printer' | 'process' | 'filament';

export function SetupScreen({
  catalog,
  selection,
  onOpen,
  onNozzle,
  onSlice,
  submitting,
  error,
  onDismissError,
  notice,
  onOpenPlater,
  plateCount,
  plateDetail,
}: {
  catalog: Catalog;
  selection: Selection;
  onOpen: (sheet: SheetName) => void;
  onNozzle: (variant: string) => void;
  onSlice: () => void;
  submitting: boolean;
  error: ApiError | null;
  onDismissError: () => void;
  notice: string | null;
  onOpenPlater: () => void;
  plateCount: number;
  plateDetail: string;
}) {
  const missing = missingStep(selection);
  const printer = selection.printer;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col">
      <header className="px-4 pt-4 pb-2">
        <h1 className="text-xl font-semibold">OrcaSlicer Web</h1>
        <p className="text-sm text-muted">Slice on the server · OrcaSlicer {catalog.orcaVersion}</p>
      </header>

      <main className="flex-1 space-y-3 px-4 pb-4">
        {notice ? (
          <p
            role="status"
            className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted"
          >
            {notice}
          </p>
        ) : null}

        {error ? <ErrorNotice error={error} onRetry={onDismissError} /> : null}

        <Row
          label="Model"
          value={selection.model?.filename ?? 'Choose a file'}
          detail={selection.model ? formatBytes(selection.model.bytes) : 'STL or 3MF'}
          onClick={() => onOpen('model')}
          testId="row-model"
        />

        {/*
          The count is `catalog.printers.length`, not `counts.printerModels`: the catalog
          reports every machine_model it found, including the few with no machine preset
          behind them, which the picker drops as unusable.
        */}
        <Row
          label="Printer"
          value={printer?.name ?? 'Choose a printer'}
          detail={printer ? printer.vendorName : `${catalog.printers.length} models`}
          onClick={() => onOpen('printer')}
          testId="row-printer"
        />

        {printer ? (
          <section
            className="rounded-xl border border-line bg-surface px-4 py-3"
            aria-labelledby="nozzle-label"
          >
            <h2 id="nozzle-label" className="text-xs tracking-wide text-muted uppercase">
              Nozzle
            </h2>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {printer.nozzles.map((nozzle) => {
                const selected = selection.nozzle === nozzle.variant;
                return (
                  <button
                    key={nozzle.variant}
                    type="button"
                    aria-pressed={selected}
                    data-testid={`nozzle-${nozzle.variant}`}
                    onClick={() => onNozzle(nozzle.variant)}
                    className={`tap rounded-xl border px-2 py-2 text-center text-base transition-colors ${
                      selected
                        ? 'border-accent bg-accent text-accent-ink font-semibold'
                        : 'border-line bg-surface-2 text-text active:bg-line'
                    }`}
                  >
                    {nozzle.variant}
                    <span className="block text-xs opacity-70">mm</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <Row
          label="Quality"
          value={selection.process?.name ?? 'Choose a quality preset'}
          detail={selection.process?.detail ?? null}
          onClick={() => onOpen('process')}
          disabled={selection.nozzle === null}
          testId="row-process"
        />

        <Row
          label="Filament"
          value={selection.filament?.name ?? 'Choose a filament'}
          detail={selection.filament?.detail ?? null}
          onClick={() => onOpen('filament')}
          disabled={selection.nozzle === null}
          testId="row-filament"
        />

        {/*
          The plate (M4). Disabled until there is something to put on it and a printer to
          put it on: the bed is drawn from the machine preset's own `printable_area`, so
          without a printer there is no plate to show.
        */}
        <Row
          label="Plate"
          value={
            plateCount === 0
              ? 'Nothing placed yet'
              : `${plateCount} object${plateCount === 1 ? '' : 's'}`
          }
          detail={plateDetail}
          onClick={onOpenPlater}
          disabled={plateCount === 0}
          testId="row-plate"
        />
      </main>

      {/*
        The primary action lives in a sticky bar at the bottom of the viewport: that is
        where a thumb rests, and it stays reachable however long the list above grows.
      */}
      <footer className="sticky bottom-0 border-t border-line bg-ink/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <Button onClick={onSlice} disabled={missing !== null || submitting} testId="slice-button">
          {submitting ? 'Sending…' : 'Slice'}
        </Button>
        {missing ? (
          <p className="mt-2 text-center text-sm text-muted" data-testid="missing-step">
            {missing}
          </p>
        ) : null}
      </footer>
    </div>
  );
}
