/**
 * The whole app: three screens (setup, plater, job) and four full-screen pickers.
 *
 * There is no router and no state library on purpose. The scope is one flow — upload,
 * choose four things, arrange the plate, slice, download — and a phone shows one thing at
 * a time anyway. M4's plater slotted in as the third screen exactly as M3 predicted,
 * fed by the same `Selection`; nothing here had to become a route first.
 *
 * Two pieces of state that M4 added and that are worth finding quickly:
 *
 *  - `plate` — what is on the build plate. It is the thing serialised into the job
 *    descriptor, so the positions the user set are the positions the engine is given
 *    (`state/plate.ts`).
 *  - `thumbnail` — a PNG of the plate, rendered from the WebGL view at the moment Slice
 *    is pressed and uploaded once the job succeeds. The slicer cannot make one (no
 *    display server, and `--min-save` omits the member entirely — SPEC deviation #5), so
 *    without this every printer shows an empty preview.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { JobScreen, type PreviewState } from './JobScreen.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PresetPicker } from './PresetPicker.tsx';
import { PrinterPicker } from './PrinterPicker.tsx';
import { SetupScreen, type SheetName } from './SetupScreen.tsx';
import { arrangePlate, loadBed, uploadPlateThumbnail } from '../api/plater.ts';
import {
  EMPTY_PLATE,
  composedRotation,
  fitProblems,
  matrixOf,
  toPlateSpec,
  type Instance,
  type Plate,
} from '../state/plate.ts';

/**
 * three.js is ~600 kB and nothing before the plater needs it, so the renderer, the mesh
 * loaders and this screen are one lazily loaded chunk. Hard constraint #5 is about the
 * phone in someone's hand, and that includes what it has to download before the first
 * screen is usable.
 */
const PlaterScreen = lazy(async () => ({
  default: (await import('./PlaterScreen.tsx')).PlaterScreen,
}));
/** M5's G-code preview: the same three.js chunk, opened from a finished job. */
const PreviewScreen = lazy(async () => ({
  default: (await import('./PreviewScreen.tsx')).PreviewScreen,
}));
const plater = () => import('./PlaterScreen.tsx');
const geometryModule = () => import('../three/geometry.ts');
const sceneModule = () => import('../three/plater-scene.ts');
import type { BedSpec, ResolvedSettings, UserPreset } from '@orca-web/shared';
import { Button, ErrorNotice, Spinner } from './primitives.tsx';

interface PresetState {
  process: PresetOption[];
  filament: PresetOption[];
  loading: boolean;
  error: ApiError | null;
}

const NO_PRESETS: PresetState = { process: [], filament: [], loading: false, error: null };

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
 * the settings sheet is opened for the first time — the setup screen must stay usable on
 * mobile data without either.
 */
interface SettingsBundle {
  schema: ConfigSchema | null;
  resolved: ResolvedSettings | null;
  loading: boolean;
  error: ApiError | null;
}

const NO_SETTINGS: SettingsBundle = {
  schema: null,
  resolved: null,
  loading: false,
  error: null,
};

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
  const [showPlater, setShowPlater] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [preview, setPreview] = useState<PreviewState>('none');
  /**
   * The job whose G-code preview is open (M5), or null.
   *
   * Seeded from `#preview=<jobId>` so a preview is addressable: the acceptance test opens
   * one for a job it sliced earlier, and a user who reloads mid-scrub comes back to it
   * rather than to the setup screen.
   */
  const [previewJob, setPreviewJob] = useState<string | null>(() => previewJobFromHash());
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
        // No bed means no plater; the descriptor falls back to letting the engine
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
  useEffect(() => {
    if (modelId === null || modelName === null) {
      setPlate(EMPTY_PLATE);
      return;
    }
    if (bed === null) return;
    let cancelled = false;
    void (async () => {
      const [{ loadGeometry, measure }, { makeInstance }] = await Promise.all([
        geometryModule(),
        plater(),
      ]);
      const geometry = await loadGeometry(modelId, modelName);
      if (cancelled) return;
      const box = measure(geometry, matrixOf({ rotation: [0, 0, 0], scale: 1 }));
      setPlate((current) => {
        if (current.instances.some((instance) => instance.modelId === modelId)) return current;
        const instance = makeInstance(modelId, modelName, box, bed);
        return { instances: [instance], selectedId: instance.id };
      });
    })().catch(() => {
      if (!cancelled) setPlate(EMPTY_PLATE);
    });
    return () => {
      cancelled = true;
    };
  }, [modelId, modelName, bed]);

  const addToPlate = useCallback(
    async (model: ModelSummary) => {
      const [{ loadGeometry, measure }, { makeInstance }] = await Promise.all([
        geometryModule(),
        plater(),
      ]);
      const geometry = await loadGeometry(model.id, model.filename);
      const box = measure(geometry, matrixOf({ rotation: [0, 0, 0], scale: 1 }));
      setPlate((current) => {
        const instance = makeInstance(model.id, model.filename, box, bed);
        // Offset so a second copy is visibly a second object rather than a collision.
        const width = box.max[0] - box.min[0];
        instance.x += current.instances.length * (Math.max(width, 10) + 5);
        return { instances: [...current.instances, instance], selectedId: instance.id };
      });
    },
    [bed],
  );

  /**
   * Auto-arrange: the engine's packer, not ours (SPEC — delegate to `--arrange 1`).
   *
   * The response is in the same terms as everything else on this boundary —
   * `world = rotation · vertex + position` — so the answer is folded back into the
   * instances by asking what centre that position implies, which keeps one convention in
   * the client instead of two.
   */
  const runArrange = useCallback(async () => {
    const current = plateRef.current;
    const machine = selectedNozzle(selection);
    if (!selection.printer || !machine || !selection.process || current.instances.length === 0) {
      return;
    }
    const response = await arrangePlate(
      { kind: 'machine', vendor: selection.printer.vendorId, name: machine.machinePresetName },
      { kind: 'process', vendor: selection.process.vendor, name: selection.process.name },
      current.instances.map((instance) => {
        const transform = matrixOf(instance);
        return { model: { source: 'library' as const, id: instance.modelId }, transform };
      }),
    );

    const { loadGeometry, measure } = await geometryModule();
    const geometries = await Promise.all(
      current.instances.map((instance) => loadGeometry(instance.modelId, instance.filename)),
    );
    setPlate((plateNow) => ({
      ...plateNow,
      instances: plateNow.instances.map((instance, index) => {
        const placed = response.instances[index];
        const geometry = geometries[index];
        if (!placed || !geometry) return instance;
        // The engine may have turned the object as well as moved it; folding its rotation
        // into the instance's own keeps the two in step. In practice 2.4.2's packer
        // returns the identity here, so this is insurance rather than routine.
        const rotation = composedRotation(placed.rotation, instance);
        const box = measure(geometry, matrixOf({ rotation, scale: instance.scale }));
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
  }, [selection]);

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
        await saveUserPreset({
          name,
          overrides: overrides.overrides,
          basedOn: presetRefs,
        });
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
    const onHashChange = (): void => setPreviewJob(previewJobFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const closePreview = useCallback(() => {
    if (window.location.hash.startsWith('#preview=')) window.location.hash = '';
    setPreviewJob(null);
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

  /**
   * Submit the plate.
   *
   * Two things happen before the request that did not in M3:
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
          setNow(Date.now());
          unsubscribe.current?.();
          unsubscribe.current = subscribeToJob(created.id, {
            onEvent: (event: JobEvent) => {
              if (event.type === 'done') attachThumbnail(event.jobId);
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
    startJob(selection, plate, overrides);
  }, [overrides, plate, selection, startJob]);

  /** What the setup screen's Plate row says underneath "N objects". */
  const plateDetail = useMemo(() => {
    if (plate.instances.length === 0) {
      return bed === null ? 'The slicer will place it' : 'Preparing…';
    }
    const problems = fitProblems(plate.instances, bed);
    if (problems.size > 0) {
      return `${problems.size} object${problems.size === 1 ? '' : 's'} the slicer would reject`;
    }
    const selectedInstance = plate.instances[0] as Instance;
    return plate.instances.length === 1
      ? `at ${Math.round(selectedInstance.x)}, ${Math.round(selectedInstance.y)} mm`
      : 'Tap to arrange';
  }, [bed, plate.instances]);

  /** What the setup screen's Settings row says underneath the count. */
  const settingsDetail = useMemo(() => {
    const keys = Object.keys(overrides.overrides);
    if (keys.length === 0) return 'Change layer height, supports, infill…';
    const named = keys
      .slice(0, 3)
      .map((key) => {
        const option = settings.schema?.options[key];
        return option === undefined ? key : (option.label ?? key);
      })
      .join(', ');
    return keys.length > 3 ? `${named} +${keys.length - 3} more` : named;
  }, [overrides, settings.schema]);

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

  if (previewJob) {
    return (
      <Suspense fallback={<Spinner label="Loading the preview…" />}>
        <PreviewScreen jobId={previewJob} bed={bed} onClose={closePreview} />
      </Suspense>
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
        onPreview={() => setPreviewJob(job.id)}
        cancelling={cancelling}
        preview={preview}
      />
    );
  }

  return (
    <>
      <SetupScreen
        catalog={catalog}
        selection={selection}
        onOpen={(name) => (name === 'settings' ? openSettings() : setSheet(name))}
        onNozzle={(variant) => setSelection((current) => withNozzle(current, variant))}
        onSlice={() => startJob(selection, plate, overrides)}
        onOpenPlater={() => setShowPlater(true)}
        plateCount={plate.instances.length}
        plateDetail={plateDetail}
        submitting={submitting}
        error={submitError}
        onDismissError={() => setSubmitError(null)}
        notice={notice}
        settingsCount={modifiedCount(overrides)}
        settingsDetail={settingsDetail}
      />

      {showPlater ? (
        <Suspense fallback={<Spinner label="Loading the plate…" />}>
          <PlaterScreen
            plate={plate}
            bed={bed}
            bedError={bedError}
            printerName={selection.printer?.name ?? ''}
            onChange={setPlate}
            onClose={() => setShowPlater(false)}
            onAddModel={() => {
              setAddingModel(true);
              setSheet('model');
            }}
            onArrange={runArrange}
            onSlice={() => startJob(selection, plate, overrides)}
            slicing={submitting}
          />
        </Suspense>
      ) : null}

      {sheet === 'model' ? (
        <ModelPicker
          recent={recent}
          selectedId={selection.model?.id ?? null}
          onSelect={(model) => {
            if (addingModel) {
              // Adding to the plate, not replacing the job's model: the plate can hold
              // several different models, and the first one chosen still names the job.
              setAddingModel(false);
              void addToPlate(model);
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
