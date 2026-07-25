/**
 * What the slice is made of: model, printer, nozzle, quality, filament, settings.
 *
 * The five rows M3 shipped as a screen, now a section of the dock. The order is not
 * stylistic: `/catalog/presets` needs a model *and* a nozzle before it can say which
 * process and filament presets are valid, so the rows below the nozzle stay disabled
 * until it is chosen — and the nozzle list comes from `nozzleVariants`, never from
 * `advertisedNozzleDiameters`, which advertises diameters that have no machine preset
 * behind them.
 *
 * Being a panel rather than a screen changes one thing about it: it is visible at the
 * same time as the plate it describes, so choosing a different nozzle re-draws the bed
 * behind it while you watch.
 */

import type { Catalog } from '../api/catalog.ts';
import { formatBytes } from '../format.ts';
import type { Selection } from '../state/selection.ts';
import { Panel, Row } from './primitives.tsx';

export type SheetName = 'model' | 'printer' | 'process' | 'filament' | 'settings';

export function PrintPanel({
  catalog,
  selection,
  onOpen,
  onNozzle,
  settingsCount,
  settingsDetail,
}: {
  catalog: Catalog;
  selection: Selection;
  onOpen: (sheet: SheetName) => void;
  onNozzle: (variant: string) => void;
  /** How many settings differ from the resolved preset (M6's diff). */
  settingsCount: number;
  settingsDetail: string;
}) {
  const printer = selection.printer;

  return (
    <Panel title="Print" testId="print-panel">
      <div className="space-y-2">
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
            className="rounded-xl border border-line bg-surface px-3 py-2.5"
            aria-labelledby="nozzle-label"
          >
            <h3 id="nozzle-label" className="text-xs tracking-wide text-muted uppercase">
              Nozzle
            </h3>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {printer.nozzles.map((nozzle) => {
                const selected = selection.nozzle === nozzle.variant;
                return (
                  <button
                    key={nozzle.variant}
                    type="button"
                    aria-pressed={selected}
                    data-testid={`nozzle-${nozzle.variant}`}
                    onClick={() => onNozzle(nozzle.variant)}
                    className={`tap rounded-xl border px-1 py-1 text-center text-sm transition-colors ${
                      selected
                        ? 'border-accent bg-accent text-accent-ink font-semibold'
                        : 'border-line bg-surface-2 text-text active:bg-line'
                    }`}
                  >
                    {nozzle.variant}
                    <span className="block text-[0.625rem] opacity-70">mm</span>
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
          Settings (M6). Last, because it is the only row that is optional: everything
          above has to be answered before a slice, this one has a correct answer already.
          It stays disabled until there is a process and a filament to diff against —
          "modified from the preset" needs a preset.
        */}
        <Row
          label="Settings"
          value={
            settingsCount === 0
              ? 'Preset values'
              : `${settingsCount} change${settingsCount === 1 ? '' : 's'}`
          }
          detail={settingsCount === 0 ? 'Change layer height, supports, infill…' : settingsDetail}
          onClick={() => onOpen('settings')}
          disabled={selection.process === null || selection.filament === null}
          testId="row-settings"
        />
      </div>
    </Panel>
  );
}
