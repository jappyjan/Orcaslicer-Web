/**
 * What is on the plate, and the numbers that put it there.
 *
 * The transform half is still an argument with one line of the brief: *"transform via an
 * explicit mode toggle (move / rotate / scale) with on-screen sliders and numeric fields —
 * not desktop-style drag gizmos, which are unusable with a thumb."* The canvas has grown
 * to fill the screen, which if anything strengthens it: a gizmo on a full-bleed viewport
 * is still a 20px handle underneath the finger aiming at it.
 *
 * So the desktop layout is adopted and the desktop *interaction* is not. Move, Rotate and
 * Scale are reachable from the floating rail — the position OrcaSlicer puts them in — but
 * what they open is a slider and a number field, not a handle in the viewport.
 */

import { useState } from 'react';
import type { BedSpec } from '@orca-web/shared';
import {
  bedCentre,
  describeProblem,
  sizeOf,
  worldBox,
  type FitProblem,
  type Instance,
  type Plate,
} from '../state/plate.ts';
import { Panel } from './primitives.tsx';

export type TransformMode = 'move' | 'rotate' | 'scale';

export interface ObjectPanelProps {
  plate: Plate;
  bed: BedSpec | null;
  problems: ReadonlyMap<string, FitProblem>;
  mode: TransformMode;
  onMode: (mode: TransformMode) => void;
  onSelect: (id: string) => void;
  onPlace: (id: string, change: Partial<Pick<Instance, 'x' | 'y' | 'z'>>) => void;
  onTransform: (id: string, change: Partial<Pick<Instance, 'rotation' | 'scale'>>) => void;
  onLayFlat: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAddModel: () => void;
  onArrange: () => void;
  arranging: boolean;
}

export function ObjectPanel({
  plate,
  bed,
  problems,
  mode,
  onMode,
  onSelect,
  onPlace,
  onTransform,
  onLayFlat,
  onDuplicate,
  onDelete,
  onAddModel,
  onArrange,
  arranging,
}: ObjectPanelProps) {
  const selected = plate.instances.find((instance) => instance.id === plate.selectedId) ?? null;

  return (
    <Panel
      title="Objects"
      testId="object-panel"
      action={
        <span className="text-xs text-muted" data-testid="object-count">
          {plate.instances.length === 1 ? '1 object' : `${plate.instances.length} objects`}
        </span>
      }
    >
      {/* The list is also the selector: a tap in a 3D view is fine for a big object and
          hopeless for a small one behind another. */}
      <div className="space-y-2">
        {plate.instances.map((instance) => {
          const isSelected = instance.id === plate.selectedId;
          const problem = problems.get(instance.id);
          const [w, d, h] = sizeOf(instance);
          return (
            <button
              key={instance.id}
              type="button"
              onClick={() => onSelect(instance.id)}
              aria-pressed={isSelected}
              data-testid={`instance-${instance.id}`}
              className={`tap flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
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
        {plate.instances.length === 0 ? (
          <p className="rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-muted">
            Nothing on the plate yet. Choose a model below, or tap Add.
          </p>
        ) : null}
      </div>

      {selected ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Transform mode">
            {(['move', 'rotate', 'scale'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={mode === candidate}
                data-testid={`mode-${candidate}`}
                onClick={() => onMode(candidate)}
                className={`tap rounded-xl border px-2 text-sm capitalize transition-colors ${
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
                  onChange={(value) => onPlace(selected.id, { x: value })}
                />
                <Field
                  label="Y"
                  unit="mm"
                  testId="field-y"
                  value={selected.y}
                  min={bedRange(bed, 1)[0]}
                  max={bedRange(bed, 1)[1]}
                  step={0.5}
                  onChange={(value) => onPlace(selected.id, { y: value })}
                />
                <Field
                  label="Lift"
                  unit="mm"
                  testId="field-z"
                  value={selected.z}
                  min={0}
                  max={Math.max(10, bed?.printableHeight ?? 100)}
                  step={0.5}
                  onChange={(value) => onPlace(selected.id, { z: value })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <SmallButton
                    label="Centre"
                    testId="centre"
                    onClick={() => {
                      const [cx, cy] = bedCentre(bed);
                      onPlace(selected.id, { x: cx, y: cy });
                    }}
                  />
                  <SmallButton
                    label="Drop to bed"
                    testId="drop"
                    onClick={() => onPlace(selected.id, { z: 0 })}
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
                      onTransform(selected.id, { rotation });
                    }}
                  />
                ))}
                <div className="grid grid-cols-3 gap-2">
                  <SmallButton
                    label="−90° Z"
                    testId="rotate-minus-90"
                    onClick={() =>
                      onTransform(selected.id, {
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
                      onTransform(selected.id, {
                        rotation: [
                          selected.rotation[0],
                          selected.rotation[1],
                          wrap(selected.rotation[2] + 90),
                        ],
                      })
                    }
                  />
                  <SmallButton
                    label="Lay flat"
                    testId="lay-flat"
                    onClick={() => onLayFlat(selected.id)}
                  />
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
                  onChange={(value) =>
                    onTransform(selected.id, { scale: clamp(value, 1, 1000) / 100 })
                  }
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
                      onClick={() => onTransform(selected.id, { scale: percent / 100 })}
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
              onClick={() => onDuplicate(selected.id)}
            />
            <SmallButton
              label="Delete"
              testId="delete"
              danger
              onClick={() => onDelete(selected.id)}
            />
          </div>
        </div>
      ) : plate.instances.length > 0 ? (
        <p className="rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-muted">
          Tap an object — on the plate or in the list — to move, rotate or resize it.
        </p>
      ) : null}

      {/*
        Auto-arrange delegates to the engine (`--arrange 1`, `POST /plater/arrange`).
        There is no bin packer in this repo: the engine is the only thing that knows its
        own clearances and exclusion zones, and it gets the last word anyway.
      */}
      <div className="grid grid-cols-2 gap-2">
        <SmallButton label="Add model" testId="add-model" onClick={onAddModel} />
        <SmallButton
          label={arranging ? 'Arranging…' : 'Auto-arrange'}
          testId="auto-arrange"
          disabled={arranging || plate.instances.length === 0}
          onClick={onArrange}
        />
      </div>
    </Panel>
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
        <label className="w-10 shrink-0 text-sm text-muted" htmlFor={`${testId}-number`}>
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
          className="tap w-24 rounded-lg border border-line bg-surface-2 px-3 py-1 text-right text-base tabular-nums focus:border-accent focus:outline-none"
        />
        <span className="w-5 shrink-0 text-sm text-muted">{unit}</span>
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
      className={`tap w-full rounded-xl border px-2 py-2 text-sm transition-colors disabled:opacity-40 ${
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

export function bedRange(bed: BedSpec | null, axis: 0 | 1): [number, number] {
  if (!bed || bed.printableArea.length === 0) return [0, 300];
  const values = bed.printableArea.map((point) => point[axis]);
  return [Math.min(...values), Math.max(...values)];
}

export function bedLabel(bed: BedSpec): string {
  const [minX, maxX] = bedRange(bed, 0);
  const [minY, maxY] = bedRange(bed, 1);
  return `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} × ${Math.round(bed.printableHeight)} mm`;
}

export function summariseProblems(
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
