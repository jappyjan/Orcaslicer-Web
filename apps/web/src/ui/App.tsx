/**
 * The whole app: two screens (setup, job) and four full-screen pickers.
 *
 * There is no router and no state library on purpose. M3's scope is one flow — upload,
 * choose four things, slice, download — and a phone shows one thing at a time anyway.
 * When M4 adds the plater it slots in as a third screen between setup and job, fed by
 * the same `Selection`; nothing here has to become a route first.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, JobEvent, ModelSummary } from '@orca-web/shared';
import {
  defaultFilament,
  defaultProcess,
  loadCatalog,
  loadPresets,
  type Catalog,
  type PresetOption,
  type PrinterOption,
} from '../api/catalog.ts';
import { asApiError } from '../api/http.ts';
import { cancelJob, createJob, subscribeToJob, uploadModel } from '../api/jobs.ts';
import {
  initialProgress,
  isActive,
  reduceProgress,
  type ProgressModel,
} from '../state/progress.ts';
import {
  buildDescriptor,
  isComplete,
  readPersisted,
  rehydrate,
  rehydratePresets,
  savePersisted,
  withNozzle,
  withPrinter,
  type PersistedSelection,
  type Selection,
} from '../state/selection.ts';
import { readRecentModels, rememberModel, saveRecentModels } from '../state/recent-models.ts';
import { JobScreen } from './JobScreen.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PresetPicker } from './PresetPicker.tsx';
import { PrinterPicker } from './PrinterPicker.tsx';
import { SetupScreen, type SheetName } from './SetupScreen.tsx';
import { Button, ErrorNotice, Spinner } from './primitives.tsx';

interface PresetState {
  process: PresetOption[];
  filament: PresetOption[];
  loading: boolean;
  error: ApiError | null;
}

const NO_PRESETS: PresetState = { process: [], filament: [], loading: false, error: null };

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<ApiError | null>(null);
  const [selection, setSelection] = useState<Selection>(() => rehydrate(null, []));
  const [presets, setPresets] = useState<PresetState>(NO_PRESETS);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [recent, setRecent] = useState<ModelSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; model: ProgressModel } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const persisted = useRef<PersistedSelection | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  /**
   * Guards the save-on-change effect below. Without it the effect fires once on mount
   * with the empty selection — before `GET /catalog` has resolved and rehydration has
   * run — and overwrites the stored selection with nothing. Caught by the Chromium pass:
   * a reload came back to "Choose a file" every time.
   */
  const hydrated = useRef(false);

  // -- start-up ------------------------------------------------------------
  // One `GET /catalog` for the whole session: 351 kB, static per OrcaSlicer version and
  // ETag-cacheable, so the second visit is a 304.
  const fetchCatalog = useCallback(() => {
    setCatalogError(null);
    loadCatalog().then(
      (loaded) => {
        setCatalog(loaded);
        persisted.current = readPersisted(storage());
        setSelection(rehydrate(persisted.current, loaded.printers));
        hydrated.current = true;
      },
      (error: unknown) => setCatalogError(asApiError(error)),
    );
  }, []);

  useEffect(() => {
    fetchCatalog();
    setRecent(readRecentModels(storage()));
  }, [fetchCatalog]);

  // -- preset lists --------------------------------------------------------
  const printerId = selection.printer?.id ?? null;
  const nozzle = selection.nozzle;

  const fetchPresets = useCallback((printer: PrinterOption | null, variant: string | null) => {
    if (!printer || variant === null) {
      setPresets(NO_PRESETS);
      return;
    }
    setPresets({ process: [], filament: [], loading: true, error: null });
    Promise.all([
      loadPresets('process', printer, variant),
      loadPresets('filament', printer, variant),
    ]).then(
      ([process, filament]) => {
        setPresets({ process, filament, loading: false, error: null });
        setSelection((current) => {
          // Only fill in what the user has not chosen: a restored selection wins over a
          // default, and a default only ever applies to an empty slot.
          const restored = rehydratePresets(current, persisted.current, process, filament);
          return {
            ...restored,
            process: restored.process ?? defaultProcess(process),
            filament: restored.filament ?? defaultFilament(filament, printer.defaultMaterials),
          };
        });
      },
      (error: unknown) =>
        setPresets({ process: [], filament: [], loading: false, error: asApiError(error) }),
    );
  }, []);

  // `selection.printer` is object-identity-stable for the life of a catalog load, so this
  // runs once per printer/nozzle pair and not on every preset change.
  const printer = selection.printer;
  useEffect(() => {
    fetchPresets(printer, nozzle);
  }, [printer, printerId, nozzle, fetchPresets]);

  // -- persistence ---------------------------------------------------------
  useEffect(() => {
    if (!hydrated.current) return;
    savePersisted(selection, storage());
  }, [selection]);

  // -- clock, for elapsed time and the quiet-stream notice ------------------
  useEffect(() => {
    if (!job || !isActive(job.model)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job]);

  useEffect(() => () => unsubscribe.current?.(), []);

  // -- actions -------------------------------------------------------------

  const handleUpload = useCallback(
    async (file: File, onProgress: (fraction: number) => void): Promise<ModelSummary> => {
      const model = await uploadModel(file, onProgress);
      setRecent((current) => {
        const next = rememberModel(current, model);
        saveRecentModels(next, storage());
        return next;
      });
      return model;
    },
    [],
  );

  const startJob = useCallback((current: Selection) => {
    if (!isComplete(current)) return;
    setSubmitError(null);
    setSubmitting(true);
    setNotice(null);

    createJob(buildDescriptor(current)).then(
      (created) => {
        setSubmitting(false);
        const started = initialProgress(Date.now());
        setJob({ id: created.id, model: { ...started, state: created.state } });
        setNow(Date.now());
        unsubscribe.current?.();
        unsubscribe.current = subscribeToJob(created.id, {
          onEvent: (event: JobEvent) =>
            setJob((state) =>
              state && state.id === event.jobId
                ? { ...state, model: reduceProgress(state.model, event, Date.now()) }
                : state,
            ),
          onDegraded: () =>
            setJob((state) =>
              state ? { ...state, model: { ...state.model, degraded: true } } : state,
            ),
          onError: (error) =>
            setJob((state) =>
              state ? { ...state, model: { ...state.model, error, state: 'failed' } } : state,
            ),
        });
      },
      (error: unknown) => {
        setSubmitting(false);
        setSubmitError(asApiError(error));
      },
    );
  }, []);

  const handleCancel = useCallback(() => {
    if (!job) return;
    setCancelling(true);
    cancelJob(job.id).then(
      () => {
        unsubscribe.current?.();
        unsubscribe.current = null;
        setCancelling(false);
        setJob(null);
        setNotice('Slice cancelled. The server cleaned up its sandbox.');
      },
      (error: unknown) => {
        setCancelling(false);
        setSubmitError(asApiError(error));
      },
    );
  }, [job]);

  const backToSetup = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    setJob(null);
  }, []);

  const sliceAgain = useCallback(() => {
    // The re-slice path the model library exists for: same `sha256:` id, no upload.
    unsubscribe.current?.();
    unsubscribe.current = null;
    setJob(null);
    startJob(selection);
  }, [selection, startJob]);

  const jobHeading = useMemo(() => {
    const parts = [selection.printer?.name, selection.nozzle ? `${selection.nozzle} mm` : null]
      .filter(Boolean)
      .join(' · ');
    return {
      name: selection.model?.filename ?? 'Slice',
      subtitle: [parts, selection.filament?.name].filter(Boolean).join(' · '),
    };
  }, [selection]);

  // -- render --------------------------------------------------------------

  if (catalogError) {
    return (
      <div className="mx-auto flex min-h-dvh w-full max-w-[30rem] flex-col justify-center gap-4 p-4">
        <ErrorNotice error={catalogError} onRetry={fetchCatalog} />
        {!catalogError.retryable ? (
          <Button variant="secondary" onClick={fetchCatalog}>
            Reload the catalog
          </Button>
        ) : null}
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Spinner label="Loading printer catalog…" />
      </div>
    );
  }

  if (job) {
    return (
      <JobScreen
        model={job.model}
        progress={jobHeading}
        now={now}
        onCancel={handleCancel}
        onSliceAgain={sliceAgain}
        onBack={backToSetup}
        cancelling={cancelling}
      />
    );
  }

  return (
    <>
      <SetupScreen
        catalog={catalog}
        selection={selection}
        onOpen={setSheet}
        onNozzle={(variant) => setSelection((current) => withNozzle(current, variant))}
        onSlice={() => startJob(selection)}
        submitting={submitting}
        error={submitError}
        onDismissError={() => setSubmitError(null)}
        notice={notice}
      />

      {sheet === 'model' ? (
        <ModelPicker
          recent={recent}
          selectedId={selection.model?.id ?? null}
          onSelect={(model) => {
            setSelection((current) => ({ ...current, model }));
            setSheet(null);
          }}
          onUpload={handleUpload}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === 'printer' ? (
        <PrinterPicker
          catalog={catalog}
          selectedId={selection.printer?.id ?? null}
          onSelect={(printer) => {
            // Changing the printer clears the presets below it — they belong to the old
            // machine and would be rejected on submit.
            persisted.current = null;
            setSelection((current) => withPrinter(current, printer));
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === 'process' || sheet === 'filament' ? (
        <PresetPicker
          kind={sheet}
          presets={sheet === 'process' ? presets.process : presets.filament}
          loading={presets.loading}
          error={presets.error}
          onRetry={() => fetchPresets(selection.printer, selection.nozzle)}
          defaultMaterials={selection.printer?.defaultMaterials ?? []}
          selectedId={(sheet === 'process' ? selection.process : selection.filament)?.id ?? null}
          onSelect={(preset) => {
            setSelection((current) =>
              sheet === 'process'
                ? { ...current, process: preset }
                : { ...current, filament: preset },
            );
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
          subtitle={`${selection.printer?.name ?? ''} ${selection.nozzle ?? ''} mm`.trim()}
        />
      ) : null}
    </>
  );
}
