/**
 * The touch plater.
 *
 * The whole screen is an argument with one line of the brief: *"transform via an explicit
 * mode toggle (move / rotate / scale) with on-screen sliders and numeric fields — not
 * desktop-style drag gizmos, which are unusable with a thumb."*
 *
 * So:
 *
 *  - **The finger in the 3D view only moves the camera.** One finger orbits, two pan and
 *    zoom, a tap selects. Nothing in the viewport is draggable, because a drag handle on
 *    a phone is a 20px target under the very finger that is meant to aim at it.
 *  - **Transforms are a mode plus a value.** Move, Rotate and Scale are three full-width
 *    tabs; each shows sliders for coarse work and a number field for exact work. A slider
 *    gives you "a bit to the left" in one gesture; the field gives you 120.00 mm, which is
 *    what the acceptance criterion is about. Neither alone is enough.
 *  - **Every action is a labelled, full-width row.** No icon-only buttons, no long-press,
 *    no context menu — none of those are discoverable without hover or a manual.
 *
 * Out-of-bounds and overlap are shown *here*, in the colour of the object and in a line of
 * text, rather than surfaced as an engine exit code a minute into a slice.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BufferGeometry } from 'three';
import type { ApiError, BedSpec } from '@orca-web/shared';
import { asApiError } from '../api/http.ts';
import {
  bedCentre,
  describeProblem,
  duplicateInstance,
  fitProblems,
  matrixOf,
  newInstanceId,
  removeInstance,
  sizeOf,
  updateInstance,
  worldBox,
  type FitProblem,
  type Instance,
  type Plate,
} from '../state/plate.ts';
import { layFlatRotation, loadGeometry, measure } from '../three/geometry.ts';
import { PlaterScene } from '../three/plater-scene.ts';
import { Button, ErrorNotice } from './primitives.tsx';

type Mode = 'move' | 'rotate' | 'scale';

export interface PlaterScreenProps {
  plate: Plate;
  bed: BedSpec | null;
  bedError: ApiError | null;
  printerName: string;
  onChange: (plate: Plate) => void;
  onClose: () => void;
  onAddModel: () => void;
  onArrange: () => Promise<void>;
  onSlice: () => void;
  slicing: boolean;
}

export function PlaterScreen(props: PlaterScreenProps) {
  const { plate, bed, printerName, onChange } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PlaterScene | null>(null);
  const [geometries, setGeometries] = useState<Map<string, BufferGeometry>>(new Map());
  const [mode, setMode] = useState<Mode>('move');
  const [error, setError] = useState<ApiError | null>(null);
  const [arranging, setArranging] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);

  const selected = plate.instances.find((instance) => instance.id === plate.selectedId) ?? null;
  const problems = useMemo(() => fitProblems(plate.instances, bed), [plate.instances, bed]);

  // -- the scene ------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: PlaterScene;
    try {
      scene = new PlaterScene(canvas, {
        onSelect: (id) => onChange({ ...plateRef.current, selectedId: id }),
      });
    } catch (cause) {
      // A browser with WebGL disabled or blocklisted still gets a usable plater: the
      // numbers below the canvas are the part that decides where things print.
      setWebglFailed(true);
      setError(asApiError(cause));
      return;
    }
    sceneRef.current = scene;

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      sceneRef.current = null;
      scene.dispose();
    };
    // Mounted once, deliberately: the scene owns a GL context, and rebuilding it on every
    // state change would drop the camera the user just set up. Everything it needs
    // afterwards arrives through the effects below or through `plateRef`.
  }, []);

  /** The latest plate, readable from the scene's tap callback without re-binding it. */
  const plateRef = useRef(plate);
  plateRef.current = plate;

  useEffect(() => {
    sceneRef.current?.setBed(bed);
  }, [bed]);

  useEffect(() => {
    sceneRef.current?.sync(plate.instances, geometries, plate.selectedId, problems);
  }, [plate.instances, plate.selectedId, geometries, problems]);

  // -- geometry -------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    const missing = plate.instances
      .map((instance) => instance)
      .filter((instance) => !geometries.has(instance.modelId));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (instance) => {
        const geometry = await loadGeometry(instance.modelId, instance.filename);
        return [instance.modelId, geometry] as const;
      }),
    ).then(
      (loaded) => {
        if (cancelled) return;
        setGeometries((current) => {
          const next = new Map(current);
          for (const [id, geometry] of loaded) next.set(id, geometry);
          return next;
        });
      },
      (cause: unknown) => {
        if (!cancelled) setError(asApiError(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [plate.instances, geometries]);

  // -- edits ----------------------------------------------------------------

  /**
   * Change a transform and re-measure in one step.
   *
   * The bounding box of the *rotated* mesh is what decides where the object sits, whether
   * it is on the bed and how tall it is, so it can never lag a rotation by a render.
   */
  const setTransform = useCallback(
    (change: Partial<Pick<Instance, 'rotation' | 'scale'>>) => {
      if (!selected) return;
      const geometry = geometries.get(selected.modelId);
      onChange(
        updateInstance(plate, selected.id, (instance) => {
          const next = { ...instance, ...change };
          return geometry ? { ...change, box: measure(geometry, matrixOf(next)) } : change;
        }),
      );
    },
    [geometries, onChange, plate, selected],
  );

  const setPlacement = useCallback(
    (change: Partial<Pick<Instance, 'x' | 'y' | 'z'>>) => {
      if (!selected) return;
      onChange(updateInstance(plate, selected.id, change));
    },
    [onChange, plate, selected],
  );

  const layFlat = useCallback(() => {
    if (!selected) return;
    const geometry = geometries.get(selected.modelId);
    if (!geometry) return;
    const rotation = layFlatRotation(geometry, selected, matrixOf(selected));
    const box = measure(geometry, matrixOf({ rotation, scale: selected.scale }));
    // Lay flat implies drop to bed: an object rotated onto its face and left hanging in
    // the air is a slice the engine rejects outright (MEASURED: exit -100).
    onChange(updateInstance(plate, selected.id, { rotation, box, z: 0 }));
  }, [geometries, onChange, plate, selected]);

  const runArrange = useCallback(() => {
    setArranging(true);
    setError(null);
    props
      .onArrange()
      .catch((cause: unknown) => setError(asApiError(cause)))
      .finally(() => setArranging(false));
  }, [props]);

  const objectCount = plate.instances.length;
  const problemText = summarise(plate.instances, problems);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-ink" data-testid="plater">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={props.onClose}
          data-testid="plater-back"
          className="tap rounded-lg px-3 text-base text-accent active:bg-surface-2"
        >
          ‹ Back
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-base font-semibold">
          Plate
          <span className="block truncate text-xs text-muted" data-testid="plate-summary">
            {objectCount === 1 ? '1 object' : `${objectCount} objects`}
            {bed ? ` · ${printerName} · ${bedLabel(bed)}` : ' · loading plate…'}
          </span>
        </h2>
      </header>

      {/* The viewport. Fixed share of the height so the controls never leave the screen —
          on a 390×844 phone a "flexible" canvas eats the buttons the moment a warning
          appears. */}
      <div className="relative h-[38vh] min-h-[220px] shrink-0 border-b border-line">
        <canvas
          ref={canvasRef}
          data-testid="plater-canvas"
          className="block h-full w-full"
          aria-label="Build plate"
        />
        {webglFailed ? (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted">
            This browser cannot show 3D. The numbers below still place objects exactly.
          </p>
        ) : null}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between p-2 text-[11px] text-muted">
          <span>Drag to turn · two fingers to pan and zoom · tap to select</span>
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
        {props.bedError ? <ErrorNotice error={props.bedError} /> : null}

        {problemText ? (
          <p
            role="status"
            data-testid="plate-problem"
            className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {problemText}
          </p>
        ) : null}

        {/* Object list: also the selector, because a tap in a 3D view is fine for a big
            object and hopeless for a small one behind another. */}
        <div className="space-y-2">
          {plate.instances.map((instance) => {
            const isSelected = instance.id === plate.selectedId;
            const problem = problems.get(instance.id);
            const [w, d, h] = sizeOf(instance);
            return (
              <button
                key={instance.id}
                type="button"
                onClick={() => onChange({ ...plate, selectedId: instance.id })}
                aria-pressed={isSelected}
                data-testid={`instance-${instance.id}`}
                className={`tap flex w-full items-center gap-3 rounded-xl border px-4 py-2 text-left transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent/10'
                    : 'border-line bg-surface active:bg-surface-2'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">{instance.filename}</span>
                  <span className="block truncate text-xs text-muted">
                    {`at ${round(instance.x)}, ${round(instance.y)} mm · ${round(w)}×${round(d)}×${round(h)} mm`}
                    {instance.scale === 1 ? '' : ` · ${Math.round(instance.scale * 100)}%`}
                  </span>
                </span>
                {problem ? (
                  <span className="shrink-0 text-xs text-danger">{describeProblem(problem)}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {selected ? (
          <>
            <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Transform mode">
              {(['move', 'rotate', 'scale'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  aria-selected={mode === candidate}
                  data-testid={`mode-${candidate}`}
                  onClick={() => setMode(candidate)}
                  className={`tap rounded-xl border px-2 text-base capitalize transition-colors ${
                    mode === candidate
                      ? 'border-accent bg-accent text-accent-ink font-semibold'
                      : 'border-line bg-surface-2 text-text active:bg-line'
                  }`}
                >
                  {candidate}
                </button>
              ))}
            </div>

            <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
              {mode === 'move' ? (
                <>
                  <Field
                    label="X"
                    unit="mm"
                    testId="field-x"
                    value={selected.x}
                    min={bedRange(bed, 0)[0]}
                    max={bedRange(bed, 0)[1]}
                    step={0.5}
                    onChange={(value) => setPlacement({ x: value })}
                  />
                  <Field
                    label="Y"
                    unit="mm"
                    testId="field-y"
                    value={selected.y}
                    min={bedRange(bed, 1)[0]}
                    max={bedRange(bed, 1)[1]}
                    step={0.5}
                    onChange={(value) => setPlacement({ y: value })}
                  />
                  <Field
                    label="Lift"
                    unit="mm"
                    testId="field-z"
                    value={selected.z}
                    min={0}
                    max={Math.max(10, bed?.printableHeight ?? 100)}
                    step={0.5}
                    onChange={(value) => setPlacement({ z: value })}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <SmallButton
                      label="Centre"
                      testId="centre"
                      onClick={() => {
                        const [cx, cy] = bedCentre(bed);
                        setPlacement({ x: cx, y: cy });
                      }}
                    />
                    <SmallButton
                      label="Drop to bed"
                      testId="drop"
                      onClick={() => setPlacement({ z: 0 })}
                    />
                  </div>
                </>
              ) : null}

              {mode === 'rotate' ? (
                <>
                  {(['X', 'Y', 'Z'] as const).map((axis, index) => (
                    <Field
                      key={axis}
                      label={axis}
                      unit="°"
                      testId={`field-r${axis.toLowerCase()}`}
                      value={selected.rotation[index] as number}
                      min={-180}
                      max={180}
                      step={1}
                      onChange={(value) => {
                        const rotation = [...selected.rotation] as [number, number, number];
                        rotation[index] = value;
                        setTransform({ rotation });
                      }}
                    />
                  ))}
                  <div className="grid grid-cols-3 gap-2">
                    <SmallButton
                      label="−90° Z"
                      testId="rotate-minus-90"
                      onClick={() =>
                        setTransform({
                          rotation: [
                            selected.rotation[0],
                            selected.rotation[1],
                            wrap(selected.rotation[2] - 90),
                          ],
                        })
                      }
                    />
                    <SmallButton
                      label="+90° Z"
                      testId="rotate-plus-90"
                      onClick={() =>
                        setTransform({
                          rotation: [
                            selected.rotation[0],
                            selected.rotation[1],
                            wrap(selected.rotation[2] + 90),
                          ],
                        })
                      }
                    />
                    <SmallButton label="Lay flat" testId="lay-flat" onClick={layFlat} />
                  </div>
                </>
              ) : null}

              {mode === 'scale' ? (
                <>
                  <Field
                    label="Size"
                    unit="%"
                    testId="field-scale"
                    value={Math.round(selected.scale * 1000) / 10}
                    min={10}
                    max={400}
                    step={1}
                    onChange={(value) => setTransform({ scale: clamp(value, 1, 1000) / 100 })}
                  />
                  <p className="text-xs text-muted" data-testid="scale-size">
                    {sizeOf(selected)
                      .map((value) => `${round(value)}`)
                      .join(' × ')}{' '}
                    mm
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {[50, 100, 200].map((percent) => (
                      <SmallButton
                        key={percent}
                        label={`${percent}%`}
                        testId={`scale-${percent}`}
                        onClick={() => setTransform({ scale: percent / 100 })}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SmallButton
                label="Duplicate"
                testId="duplicate"
                onClick={() => onChange(duplicateInstance(plate, selected.id))}
              />
              <SmallButton
                label="Delete"
                testId="delete"
                danger
                onClick={() => onChange(removeInstance(plate, selected.id))}
              />
            </div>
          </>
        ) : (
          <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
            Tap an object to move, rotate or resize it.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <SmallButton label="Add model" testId="add-model" onClick={props.onAddModel} />
          <SmallButton
            label={arranging ? 'Arranging…' : 'Auto-arrange'}
            testId="auto-arrange"
            disabled={arranging || plate.instances.length === 0}
            onClick={runArrange}
          />
        </div>
      </div>

      <footer className="sticky bottom-0 shrink-0 border-t border-line bg-ink/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <Button
          onClick={props.onSlice}
          disabled={props.slicing || objectCount === 0}
          testId="plater-slice"
        >
          {props.slicing ? 'Sending…' : 'Slice'}
        </Button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * A slider and a number field for the same value.
 *
 * Both, not either: the slider is how you say "a bit more" with a thumb, and the field is
 * how you say 120. A slider alone cannot hit a millimetre on a 390px screen (a 256 mm bed
 * is about 0.7 mm per pixel), and a field alone makes every adjustment a keyboard session.
 */
function Field({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
  testId,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  testId: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);

  return (
    <div>
      <div className="flex items-center gap-3">
        <label className="w-12 shrink-0 text-sm text-muted" htmlFor={`${testId}-number`}>
          {label}
        </label>
        <input
          id={`${testId}-number`}
          data-testid={testId}
          type="number"
          inputMode="decimal"
          value={shown}
          step={step}
          onChange={(event) => {
            setDraft(event.target.value);
            const parsed = Number.parseFloat(event.target.value);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={() => setDraft(null)}
          className="tap w-28 rounded-lg border border-line bg-surface-2 px-3 py-1 text-right text-base tabular-nums focus:border-accent focus:outline-none"
        />
        <span className="w-6 shrink-0 text-sm text-muted">{unit}</span>
      </div>
      <input
        type="range"
        aria-label={`${label} slider`}
        data-testid={`${testId}-slider`}
        value={clamp(value, min, max)}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          setDraft(null);
          onChange(Number.parseFloat(event.target.value));
        }}
        className="mt-1 h-11 w-full accent-[color:var(--color-accent)]"
      />
    </div>
  );
}

function SmallButton({
  label,
  onClick,
  testId,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`tap w-full rounded-xl border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
        danger
          ? 'border-danger/50 bg-transparent text-danger active:bg-danger/10'
          : 'border-line bg-surface-2 text-text active:bg-line'
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrap(degrees: number): number {
  if (degrees > 180) return degrees - 360;
  if (degrees <= -180) return degrees + 360;
  return degrees;
}

function bedRange(bed: BedSpec | null, axis: 0 | 1): [number, number] {
  if (!bed || bed.printableArea.length === 0) return [0, 300];
  const values = bed.printableArea.map((point) => point[axis]);
  return [Math.min(...values), Math.max(...values)];
}

function bedLabel(bed: BedSpec): string {
  const [minX, maxX] = bedRange(bed, 0);
  const [minY, maxY] = bedRange(bed, 1);
  return `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} × ${Math.round(bed.printableHeight)} mm`;
}

function summarise(
  instances: readonly Instance[],
  problems: ReadonlyMap<string, FitProblem>,
): string | null {
  if (problems.size === 0) return null;
  const names = instances
    .filter((instance) => problems.has(instance.id))
    .map((instance) => instance.filename);
  const kinds = new Set([...problems.values()].map(describeProblem));
  const heights = instances
    .filter((instance) => problems.get(instance.id) === 'too-tall')
    .map((instance) => Math.round(worldBox(instance).max[2]));
  const tall = heights.length > 0 ? ` (${heights.join(', ')} mm tall)` : '';
  return `${[...kinds].join(' · ')}: ${[...new Set(names)].join(', ')}${tall}. The slicer will refuse this plate.`;
}

/** A fresh instance of a model, centred on the plate and sitting on it. */
export function makeInstance(
  modelId: string,
  filename: string,
  box: Instance['box'],
  bed: BedSpec | null,
): Instance {
  const [x, y] = bedCentre(bed);
  return {
    id: newInstanceId(),
    modelId,
    filename,
    x,
    y,
    z: 0,
    rotation: [0, 0, 0],
    scale: 1,
    box,
  };
}
