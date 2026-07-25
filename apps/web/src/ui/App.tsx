/**
 * The whole app: one workspace, two stages, five full-screen sheets.
 *
 * There is still no router and no state library. What changed in this milestone is the
 * *shape*: instead of three screens that replace one another (setup → plater → job), there
 * is one 3D viewport with everything floating over it, and a `Prepare` / `Preview` switch
 * between the plate and the toolpath — the arrangement OrcaSlicer's desktop build and
 * SimplyPrint's web slicer both use. `Workspace` owns that layout; this file owns the
 * state, exactly as before, and hands the pieces down as slots.
 *
 * Three pieces of state worth finding quickly:
 *
 *  - `plate` — what is on the build plate. It is the thing serialised into the job
 *    descriptor, so the positions the user set are the positions the engine is given
 *    (`state/plate.ts`). Edits go through `usePlateEditor`, which owns the geometry cache
 *    and keeps three.js out of the first bundle.
 *  - `thumbnail` — a PNG of the plate, rendered from the WebGL view at the moment Slice is
 *    pressed and uploaded once the job succeeds. The slicer cannot make one (no display
 *    server, and `--min-save` omits the member entirely — SPEC deviation #5), so without
 *    this every printer shows an empty preview.
 *  - `stage` / `previewJob` — which of the two views is up. A slice no longer takes the
 *    screen away: progress arrives in the dock while the plate stays visible, and the
 *    finished toolpath is one tap away in the same viewport.
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
  missingStep,
  readPersisted,
  rehydrate,
  rehydratePresets,
  savePersisted,
  selectedNozzle,
  withNozzle,
  withPrinter,
  type PersistedSelection,
  type Selection,
} from '../state/selection.ts';
import { readRecentModels, rememberModel, saveRecentModels } from '../state/recent-models.ts';
import {
  deleteUserPreset,
  loadConfigSchema,
  loadResolvedSettings,
  loadUserPresets,
  saveUserPreset,
} from '../api/settings.ts';
import {
  NO_OVERRIDES,
  modifiedCount,
  reconcile,
  type ConfigSchema,
  type SettingsState,
} from '../state/settings.ts';
import { SettingsScreen } from './SettingsScreen.tsx';
import { JobPanel, type PreviewState } from './JobPanel.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PresetPicker } from './PresetPicker.tsx';
import { PrinterPicker } from './PrinterPicker.tsx';
import { PrintPanel, type SheetName } from './PrintPanel.tsx';
import { PrepareView } from './PrepareView.tsx';
import { PreviewView } from './PreviewView.tsx';
import { bedLabel } from './ObjectPanel.tsx';
import { TitleBlock, type Chrome } from './Workspace.tsx';
import { arrangePlate, loadBed, uploadPlateThumbnail } from '../api/plater.ts';
import {
  EMPTY_PLATE,
  composedRotation,
  duplicateInstance,
  matrixOf,
  removeInstance,
  toPlateSpec,
  type Plate,
} from '../state/plate.ts';
import { geometryModule, usePlateEditor } from '../state/plate-editor.ts';
import type { BedSpec, ResolvedSettings, UserPreset } from '@orca-web/shared';
import { Button, ErrorNotice, Segmented, Spinner } from './primitives.tsx';

/** The plate thumbnail's renderer. Same three.js chunk the stage loads, fetched on demand. */
const sceneModule = () => import('../three/plater-scene.ts');

interface PresetState {
  process: PresetOption[];
  filament: PresetOption[];
  loading: boolean;
  error: ApiError | null;
}

const NO_PRESETS: PresetState = { process: [], filament: [], loading: false, error: null };

type Stage = 'prepare' | 'preview';

/** `#preview=<jobId>` — the one deep link this app has, and M5's acceptance test uses it. */
function previewJobFromHash(): string | null {
  try {
    const match = /^#preview=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
    return match ? (match[1] as string) : null;
  } catch {
    return null;
  }
}

/**
 * M6's settings, as one lazily-filled bundle.
 *
 * `schema` is 708 kB and `resolved` needs three preset names, so neither is fetched until
 * the settings sheet is opened for the first time — the workspace must stay usable on
 * mobile data without either.
 */
interface SettingsBundle {
  schema: ConfigSchema | null;
  resolved: ResolvedSettings | null;
  loading: boolean;
  error: ApiError | null;
}

const NO_SETTINGS: SettingsBundle = { schema: null, resolved: null, loading: false, error: null };

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
  const [bed, setBed] = useState<BedSpec | null>(null);
  const [bedError, setBedError] = useState<ApiError | null>(null);
  const [plate, setPlate] = useState<Plate>(EMPTY_PLATE);
  const [addingModel, setAddingModel] = useState(false);
  const [preview, setPreview] = useState<PreviewState>('none');
  /**
   * The job whose G-code preview is available, or null.
   *
   * Seeded from `#preview=<jobId>` so a preview is addressable: the acceptance test opens
   * one for a job it sliced earlier, and a user who reloads mid-scrub comes back to it
   * rather than to an empty plate.
   */
  const [previewJob, setPreviewJob] = useState<string | null>(() => previewJobFromHash());
  const [stage, setStage] = useState<Stage>(() => (previewJobFromHash() ? 'preview' : 'prepare'));
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [settings, setSettings] = useState<SettingsBundle>(NO_SETTINGS);
  const [overrides, setOverrides] = useState<SettingsState>(NO_OVERRIDES);
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [presetError, setPresetError] = useState<ApiError | null>(null);

  /** Captured when Slice is pressed; uploaded when the job succeeds. */
  const thumbnail = useRef<Blob | null>(null);
  /** Latest bed and plate, readable from callbacks that must not be re-bound per edit. */
  const bedRef = useRef<BedSpec | null>(null);
  bedRef.current = bed;
  const plateRef = useRef<Plate>(plate);
  plateRef.current = plate;
  const persisted = useRef<PersistedSelection | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  /**
   * Guards the save-on-change effect below. Without it the effect fires once on mount
   * with the empty selection — before `GET /catalog` has resolved and rehydration has
   * run — and overwrites the stored selection with nothing.
   */
  const hydrated = useRef(false);

  const editor = usePlateEditor({ plate, bed, onChange: setPlate });

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

  // -- the build plate -----------------------------------------------------
  // The bed comes from the selected machine preset — `printable_area` /
  // `printable_height`, fully resolved. Never a hardcoded 256x256: a plater that draws
  // the wrong bed is worse than no plater, because it looks right.
  useEffect(() => {
    if (!printer || nozzle === null) {
      setBed(null);
      return;
    }
    let cancelled = false;
    setBedError(null);
    loadBed(printer, nozzle).then(
      (loaded) => {
        if (!cancelled) setBed(loaded);
      },
      (error: unknown) => {
        if (cancelled) return;
        // No bed means no plate; the descriptor falls back to letting the engine
        // arrange, which is exactly M3's behaviour.
        setBed(null);
        setBedError(asApiError(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [printer, nozzle]);

  /**
   * Choosing a model puts one copy of it on the plate, centred.
   *
   * Measured before it is placed: every placement question — where its centre is, whether
   * it is on the bed — is a question about the mesh's bounds, and an instance whose bounds
   * are a guess would slice somewhere other than where it was drawn. A model whose format
   * the viewer cannot read leaves the plate empty on purpose, and the job descriptor then
   * falls back to letting the engine arrange it.
   */
  const modelId = selection.model?.id ?? null;
  const modelName = selection.model?.filename ?? null;
  const setOnly = editor.setOnly;
  useEffect(() => {
    if (modelId === null || modelName === null) {
      setPlate(EMPTY_PLATE);
      return;
    }
    if (bed === null) return;
    void setOnly({ id: modelId, filename: modelName });
  }, [modelId, modelName, bed, setOnly]);

  /**
   * Auto-arrange: the engine's packer, not ours (SPEC — delegate to `--arrange 1`).
   *
   * The response is in the same terms as everything else on this boundary —
   * `world = rotation · vertex + position` — so the answer is folded back into the
   * instances by asking what centre that position implies, which keeps one convention in
   * the client instead of two.
   */
  const remeasure = editor.remeasure;
  const runArrange = useCallback(async () => {
    const current = plateRef.current;
    const machine = selectedNozzle(selection);
    if (!selection.printer || !machine || !selection.process || current.instances.length === 0) {
      return;
    }
    const response = await arrangePlate(
      { kind: 'machine', vendor: selection.printer.vendorId, name: machine.machinePresetName },
      { kind: 'process', vendor: selection.process.vendor, name: selection.process.name },
      current.instances.map((instance) => ({
        model: { source: 'library' as const, id: instance.modelId },
        transform: matrixOf(instance),
      })),
    );

    // The engine may have turned the object as well as moved it; folding its rotation
    // into the instance's own keeps the two in step. In practice 2.4.2's packer returns
    // the identity here, so this is insurance rather than routine.
    const placements = await Promise.all(
      current.instances.map(async (instance, index) => {
        const placed = response.instances[index];
        if (!placed) return null;
        const rotation = composedRotation(placed.rotation, instance);
        return { id: instance.id, rotation, box: await remeasure(instance, rotation), placed };
      }),
    );

    setPlate((plateNow) => ({
      ...plateNow,
      instances: plateNow.instances.map((instance) => {
        const update = placements.find((candidate) => candidate?.id === instance.id);
        if (!update) return instance;
        const { box, rotation, placed } = update;
        return {
          ...instance,
          rotation,
          box,
          x: placed.position[0] + (box.min[0] + box.max[0]) / 2,
          y: placed.position[1] + (box.min[1] + box.max[1]) / 2,
          z: placed.position[2] + box.min[2],
        };
      }),
    }));
  }, [remeasure, selection]);

  // -- settings (M6) -------------------------------------------------------
  /** The three presets a slice would resolve — the base the settings diff is taken from. */
  const presetRefs = useMemo(() => {
    const machine = selectedNozzle(selection);
    if (!selection.printer || !machine || !selection.process || !selection.filament) return null;
    return {
      machine: {
        kind: 'machine' as const,
        vendor: selection.printer.vendorId,
        name: machine.machinePresetName,
      },
      process: {
        kind: 'process' as const,
        vendor: selection.process.vendor,
        name: selection.process.name,
      },
      filament: {
        kind: 'filament' as const,
        vendor: selection.filament.vendor,
        name: selection.filament.name,
      },
    };
  }, [selection]);

  /**
   * Fetch the schema and the resolved preset. Called when the settings sheet opens and
   * again whenever the presets underneath it change — a stale baseline would mislabel
   * every field as modified or not.
   */
  const fetchSettings = useCallback(() => {
    if (presetRefs === null) return;
    setSettings((current) => ({ ...current, loading: true, error: null }));
    Promise.all([loadConfigSchema(), loadResolvedSettings(presetRefs)]).then(
      ([schema, resolved]) => {
        setSettings({ schema, resolved, loading: false, error: null });
        // An override that now equals its new preset is no longer a modification.
        setOverrides((current) => reconcile(current, schema, resolved));
      },
      (error: unknown) =>
        setSettings((current) => ({ ...current, loading: false, error: asApiError(error) })),
    );
  }, [presetRefs]);

  useEffect(() => {
    // Only refresh what is already loaded: opening the sheet is what pays the 708 kB.
    // Keyed on the presets alone: depending on `fetchSettings` (which closes over them)
    // or on the bundle it writes would make this a loop.
    if (settings.schema !== null) fetchSettings();
  }, [presetRefs]);

  const openSettings = useCallback(() => {
    setSheet('settings');
    if (settings.schema === null) fetchSettings();
    loadUserPresets().then(setUserPresets, () => setUserPresets([]));
  }, [fetchSettings, settings.schema]);

  const savePreset = useCallback(
    async (name: string) => {
      setPresetError(null);
      try {
        await saveUserPreset({ name, overrides: overrides.overrides, basedOn: presetRefs });
        setUserPresets(await loadUserPresets());
      } catch (error) {
        setPresetError(asApiError(error));
      }
    },
    [overrides, presetRefs],
  );

  const removePreset = useCallback(async (id: string) => {
    setPresetError(null);
    try {
      await deleteUserPreset(id);
      setUserPresets(await loadUserPresets());
    } catch (error) {
      setPresetError(asApiError(error));
    }
  }, []);

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

  // Following `#preview=<jobId>` while the app is already open is a same-document
  // navigation: nothing remounts, so without this the link silently does nothing.
  useEffect(() => {
    const onHashChange = (): void => {
      const fromHash = previewJobFromHash();
      setPreviewJob(fromHash);
      setStage(fromHash ? 'preview' : 'prepare');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const closePreview = useCallback(() => {
    if (window.location.hash.startsWith('#preview=')) window.location.hash = '';
    setStage('prepare');
  }, []);

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

  /** Write the captured preview into the finished archive, then let the download appear. */
  const attachThumbnail = useCallback((jobId: string) => {
    const png = thumbnail.current;
    if (!png) {
      setPreview('none');
      return;
    }
    setPreview('uploading');
    uploadPlateThumbnail(jobId, png).then(
      () => setPreview('done'),
      // A failed rewrite costs a preview picture on the printer's screen and nothing
      // else; the G-code in the archive is untouched either way.
      () => setPreview('failed'),
    );
  }, []);

  /**
   * Submit the plate.
   *
   *  1. the plate is serialised into the descriptor with `arrange: false` and real
   *     positions, so the slice lands where the screen said (`state/plate.ts`);
   *  2. a PNG of the plate is rendered off-screen and held until the job succeeds, at
   *     which point it is written into the `.gcode.3mf`. The slicer cannot produce one
   *     (no display server) and `--min-save` leaves the member out entirely, so the
   *     printer's screen would otherwise show an empty preview.
   */
  const startJob = useCallback(
    (current: Selection, currentPlate: Plate, currentOverrides: SettingsState) => {
      if (!isComplete(current)) return;
      setSubmitError(null);
      setSubmitting(true);
      setNotice(null);
      setPreview('none');
      setStage('prepare');

      const placed =
        currentPlate.instances.length > 0 ? toPlateSpec(currentPlate.instances) : undefined;
      thumbnail.current = null;
      // Fire-and-forget: a preview is worth a round trip, never worth blocking a slice.
      void (async () => {
        const [{ loadGeometry }, { renderPlateThumbnail }] = await Promise.all([
          geometryModule(),
          sceneModule(),
        ]);
        const entries = await Promise.all(
          [...new Set(currentPlate.instances.map((instance) => instance.modelId))].map(
            async (id) => {
              const instance = currentPlate.instances.find((candidate) => candidate.modelId === id);
              return [id, await loadGeometry(id, instance?.filename ?? '')] as const;
            },
          ),
        );
        thumbnail.current = await renderPlateThumbnail(
          bedRef.current,
          currentPlate.instances,
          new Map(entries),
        );
      })().catch(() => {
        thumbnail.current = null;
      });

      // Diff-and-override: only the keys that differ from the resolved preset travel, as
      // flags. No profile file is written, here or on the server.
      createJob(buildDescriptor(current, placed, currentOverrides.overrides)).then(
        (created) => {
          setSubmitting(false);
          const started = initialProgress(Date.now());
          setJob({ id: created.id, model: { ...started, state: created.state } });
          setPreviewJob(null);
          setNow(Date.now());
          unsubscribe.current?.();
          unsubscribe.current = subscribeToJob(created.id, {
            onEvent: (event: JobEvent) => {
              if (event.type === 'done') {
                attachThumbnail(event.jobId);
                setPreviewJob(event.jobId);
              }
              setJob((state) =>
                state && state.id === event.jobId
                  ? { ...state, model: reduceProgress(state.model, event, Date.now()) }
                  : state,
              );
            },
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
    },
    [attachThumbnail],
  );

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

  const dismissJob = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    setJob(null);
  }, []);

  const sliceAgain = useCallback(() => {
    // The re-slice path the model library exists for: same `sha256:` id, no upload.
    unsubscribe.current?.();
    unsubscribe.current = null;
    setJob(null);
    startJob(selection, plate, overrides);
  }, [overrides, plate, selection, startJob]);

  /** What the Settings row says underneath the count. */
  const settingsDetail = useMemo(() => {
    const keys = Object.keys(overrides.overrides);
    if (keys.length === 0) return 'Change layer height, supports, infill…';
    const named = keys
      .slice(0, 3)
      .map((key) => settings.schema?.options[key]?.label ?? key)
      .join(', ');
    return keys.length > 3 ? `${named} +${keys.length - 3} more` : named;
  }, [overrides, settings.schema]);

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

  const missing = missingStep(selection);
  const active = job !== null && isActive(job.model);
  const canPreview = previewJob !== null;

  const chrome: Chrome = {
    title: (
      <TitleBlock
        name={selection.model?.filename ?? 'OrcaSlicer Web'}
        detail={plateSummary(plate, bed, selection.printer?.name ?? '', catalog.orcaVersion)}
        detailTestId="plate-summary"
      />
    ),
    tabs: (
      <Segmented
        compact
        label="Workspace"
        testIdPrefix="stage"
        value={stage}
        onChange={(next) => (next === 'preview' ? setStage('preview') : closePreview())}
        options={[
          { value: 'prepare', label: 'Prepare' },
          { value: 'preview', label: 'Preview', disabled: !canPreview },
        ]}
      />
    ),
    status: job ? (
      <p className="px-2 text-xs text-muted tabular-nums">
        {active ? `${Math.round(job.model.percent)}%` : 'Done'}
      </p>
    ) : null,
    jobPanel: job ? (
      <JobPanel
        model={job.model}
        now={now}
        onCancel={handleCancel}
        onSliceAgain={sliceAgain}
        onDismiss={dismissJob}
        onPreview={previewJob ? () => setStage('preview') : undefined}
        cancelling={cancelling}
        preview={preview}
      />
    ) : null,
    printPanel: (
      <PrintPanel
        catalog={catalog}
        selection={selection}
        onOpen={(name) => (name === 'settings' ? openSettings() : setSheet(name))}
        onNozzle={(variant) => setSelection((current) => withNozzle(current, variant))}
        settingsCount={modifiedCount(overrides)}
        settingsDetail={settingsDetail}
      />
    ),
    action:
      stage === 'preview' ? (
        <Button variant="secondary" onClick={closePreview} testId="preview-back">
          Back to the plate
        </Button>
      ) : (
        <div className="space-y-2">
          {submitError ? (
            <ErrorNotice error={submitError} onRetry={() => setSubmitError(null)} />
          ) : null}
          {notice ? (
            <p role="status" className="text-center text-xs text-muted">
              {notice}
            </p>
          ) : null}
          <Button
            onClick={() => startJob(selection, plate, overrides)}
            disabled={missing !== null || submitting || active}
            testId="slice-button"
          >
            {submitting ? 'Sending…' : active ? 'Slicing…' : 'Slice'}
          </Button>
          {missing ? (
            <p className="text-center text-xs text-muted" data-testid="missing-step">
              {missing}
            </p>
          ) : null}
        </div>
      ),
    // A new job raises the sheet on a phone: progress that arrives below the fold reads
    // as nothing having happened.
    revealSignal: job?.id ?? null,
  };

  return (
    <>
      {stage === 'preview' && previewJob ? (
        <PreviewView jobId={previewJob} bed={bed} onClose={closePreview} chrome={chrome} />
      ) : (
        <PrepareView
          plate={plate}
          bed={bed}
          bedError={bedError}
          editor={editor}
          onSelect={(id) => setPlate((current) => ({ ...current, selectedId: id }))}
          onDuplicate={(id) => setPlate((current) => duplicateInstance(current, id))}
          onDelete={(id) => setPlate((current) => removeInstance(current, id))}
          onAddModel={() => {
            setAddingModel(true);
            setSheet('model');
          }}
          onArrange={runArrange}
          chrome={chrome}
        />
      )}

      {sheet === 'model' ? (
        <ModelPicker
          recent={recent}
          selectedId={selection.model?.id ?? null}
          onSelect={(model) => {
            if (addingModel) {
              // Adding to the plate, not replacing the job's model: the plate can hold
              // several different models, and the first one chosen still names the job.
              setAddingModel(false);
              void editor.add(model);
              setSheet(null);
              return;
            }
            setSelection((current) => ({ ...current, model }));
            setSheet(null);
          }}
          onUpload={handleUpload}
          onClose={() => {
            setAddingModel(false);
            setSheet(null);
          }}
        />
      ) : null}

      {sheet === 'printer' ? (
        <PrinterPicker
          catalog={catalog}
          selectedId={selection.printer?.id ?? null}
          onSelect={(chosen) => {
            // Changing the printer clears the presets below it — they belong to the old
            // machine and would be rejected on submit.
            persisted.current = null;
            setSelection((current) => withPrinter(current, chosen));
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === 'settings' ? (
        <SettingsScreen
          schema={settings.schema}
          resolved={settings.resolved}
          loading={settings.loading}
          error={settings.error}
          onRetry={fetchSettings}
          state={overrides}
          onChange={setOverrides}
          onClose={() => setSheet(null)}
          userPresets={userPresets}
          presetContext={presetRefs}
          onSavePreset={savePreset}
          onDeletePreset={removePreset}
          presetError={presetError}
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

/**
 * The line under the title: how many objects, on whose plate, how big that plate is.
 *
 * Falls back to the OrcaSlicer version before a printer is chosen, because at that point
 * the only honest thing to say about the plate is which slicer will be doing the slicing.
 */
function plateSummary(
  plate: Plate,
  bed: BedSpec | null,
  printerName: string,
  orcaVersion: string,
): string {
  if (!bed) return `Slice on the server · OrcaSlicer ${orcaVersion}`;
  const objects = plate.instances.length === 1 ? '1 object' : `${plate.instances.length} objects`;
  return `${objects} · ${printerName} · ${bedLabel(bed)}`;
}
