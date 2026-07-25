/**
 * Everything that edits the plate, in one place and out of the WebGL chunk.
 *
 * The layout change made this necessary rather than merely tidy. The plate's controls now
 * live in the dock, which is ordinary React over the canvas, while the canvas itself is a
 * lazily-loaded three.js chunk — so a transform panel that imported `three` to re-measure
 * a rotated mesh would drag the renderer into the first bundle by the back door.
 *
 * The one piece of three.js the editing genuinely needs is {@link measure}: the bounds of
 * a *rotated* mesh, which decide where an object sits, whether it is on the bed and how
 * tall it is (a rotated axis-aligned box is wrong by up to 41 % on a diagonal — see
 * `three/geometry.ts`). That arrives through the same dynamic import the stage uses, is
 * kept in a ref once resolved, and every edit after the first is synchronous.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BufferGeometry } from 'three';
import type { ApiError, BedSpec, ModelSummary } from '@orca-web/shared';
import { asApiError } from '../api/http.ts';
import {
  bedCentre,
  matrixOf,
  newInstanceId,
  updateInstance,
  type Box3Like,
  type Instance,
  type Plate,
} from './plate.ts';

/**
 * Typed against the module's own exports without importing it: naming the type is free,
 * naming the *module* would put three.js in this chunk and defeat the whole arrangement.
 */
type GeometryModule = Awaited<ReturnType<typeof importGeometry>>;

const importGeometry = () => import('../three/geometry.ts');

let pending: ReturnType<typeof importGeometry> | null = null;

/** The mesh loader and the measurements, fetched once per session. */
export function geometryModule(): Promise<GeometryModule> {
  pending ??= importGeometry();
  return pending;
}

/** A fresh instance of a model, centred on the plate and sitting on it. */
export function makeInstance(
  modelId: string,
  filename: string,
  box: Box3Like,
  bed: BedSpec | null,
): Instance {
  const [x, y] = bedCentre(bed);
  return { id: newInstanceId(), modelId, filename, x, y, z: 0, rotation: [0, 0, 0], scale: 1, box };
}

export interface PlateEditor {
  /** One `BufferGeometry` per model id, shared by every instance of it. */
  geometries: ReadonlyMap<string, BufferGeometry>;
  /** A model that could not be fetched or parsed. The plate stays usable. */
  error: ApiError | null;
  dismissError: () => void;
  /** Put one copy of a model on the plate, replacing whatever is there. */
  setOnly: (model: Pick<ModelSummary, 'id' | 'filename'>) => Promise<void>;
  /** Add another object, offset far enough to read as a second one. */
  add: (model: Pick<ModelSummary, 'id' | 'filename'>) => Promise<void>;
  /** Move: no re-measure, because the bounds of a translated mesh are the same bounds. */
  place: (id: string, change: Partial<Pick<Instance, 'x' | 'y' | 'z'>>) => void;
  /** Rotate or resize: the bounds change with it, and must not lag it by a render. */
  transform: (id: string, change: Partial<Pick<Instance, 'rotation' | 'scale'>>) => void;
  /** Turn the largest flat face down, and drop it onto the bed. */
  layFlat: (id: string) => void;
  /** Re-measure after the engine's arranger has moved and possibly turned things. */
  remeasure: (instance: Instance, rotation: [number, number, number]) => Promise<Box3Like>;
}

export function usePlateEditor({
  plate,
  bed,
  onChange,
}: {
  plate: Plate;
  bed: BedSpec | null;
  onChange: (next: Plate | ((current: Plate) => Plate)) => void;
}): PlateEditor {
  const [geometries, setGeometries] = useState<Map<string, BufferGeometry>>(new Map());
  const [error, setError] = useState<ApiError | null>(null);
  /** Resolved once the chunk lands; every edit after that is synchronous. */
  const three = useRef<GeometryModule | null>(null);
  const geometryRef = useRef(geometries);
  geometryRef.current = geometries;
  const bedRef = useRef(bed);
  bedRef.current = bed;

  useEffect(() => {
    let cancelled = false;
    void geometryModule().then((loaded) => {
      if (!cancelled) three.current = loaded;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Load whatever the plate references and is not cached yet. */
  useEffect(() => {
    const missing = plate.instances.filter(
      (instance) => !geometryRef.current.has(instance.modelId),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void geometryModule()
      .then((module) =>
        Promise.all(
          missing.map(
            async (instance) =>
              [
                instance.modelId,
                await module.loadGeometry(instance.modelId, instance.filename),
              ] as const,
          ),
        ),
      )
      .then(
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
  }, [plate.instances]);

  const load = useCallback(async (modelId: string, filename: string): Promise<BufferGeometry> => {
    const cached = geometryRef.current.get(modelId);
    if (cached) return cached;
    const module = three.current ?? (await geometryModule());
    const geometry = await module.loadGeometry(modelId, filename);
    setGeometries((current) => new Map(current).set(modelId, geometry));
    return geometry;
  }, []);

  const measured = useCallback(
    async (model: Pick<ModelSummary, 'id' | 'filename'>): Promise<Instance> => {
      const module = three.current ?? (await geometryModule());
      const geometry = await load(model.id, model.filename);
      const box = module.measure(geometry, matrixOf({ rotation: [0, 0, 0], scale: 1 }));
      return makeInstance(model.id, model.filename, box, bedRef.current);
    },
    [load],
  );

  const setOnly = useCallback(
    async (model: Pick<ModelSummary, 'id' | 'filename'>): Promise<void> => {
      try {
        const instance = await measured(model);
        onChange((current) =>
          // Already there — the effect that watches the chosen model re-runs on a
          // reload, and re-centring someone's arrangement would be a data loss.
          current.instances.some((candidate) => candidate.modelId === model.id)
            ? current
            : { instances: [instance], selectedId: instance.id },
        );
      } catch (cause) {
        setError(asApiError(cause));
        onChange({ instances: [], selectedId: null });
      }
    },
    [measured, onChange],
  );

  const add = useCallback(
    async (model: Pick<ModelSummary, 'id' | 'filename'>): Promise<void> => {
      try {
        const instance = await measured(model);
        onChange((current) => {
          const width = instance.box.max[0] - instance.box.min[0];
          const placed = {
            ...instance,
            x: instance.x + current.instances.length * (Math.max(width, 10) + 5),
          };
          return { instances: [...current.instances, placed], selectedId: placed.id };
        });
      } catch (cause) {
        setError(asApiError(cause));
      }
    },
    [measured, onChange],
  );

  const place = useCallback(
    (id: string, change: Partial<Pick<Instance, 'x' | 'y' | 'z'>>): void => {
      onChange((current) => updateInstance(current, id, change));
    },
    [onChange],
  );

  const transform = useCallback(
    (id: string, change: Partial<Pick<Instance, 'rotation' | 'scale'>>): void => {
      const module = three.current;
      onChange((current) =>
        updateInstance(current, id, (instance) => {
          const geometry = geometryRef.current.get(instance.modelId);
          if (!module || !geometry) return change;
          const next = { ...instance, ...change };
          return { ...change, box: module.measure(geometry, matrixOf(next)) };
        }),
      );
    },
    [onChange],
  );

  const layFlat = useCallback(
    (id: string): void => {
      const module = three.current;
      onChange((current) =>
        updateInstance(current, id, (instance) => {
          const geometry = geometryRef.current.get(instance.modelId);
          if (!module || !geometry) return {};
          const rotation = module.layFlatRotation(geometry, instance, matrixOf(instance));
          // Lay flat implies drop to bed: an object rotated onto its face and left
          // hanging in the air is a slice the engine rejects outright (MEASURED: -100).
          return {
            rotation,
            box: module.measure(geometry, matrixOf({ rotation, scale: instance.scale })),
            z: 0,
          };
        }),
      );
    },
    [onChange],
  );

  const remeasure = useCallback(
    async (instance: Instance, rotation: [number, number, number]): Promise<Box3Like> => {
      const module = three.current ?? (await geometryModule());
      const geometry = await load(instance.modelId, instance.filename);
      return module.measure(geometry, matrixOf({ rotation, scale: instance.scale }));
    },
    [load],
  );

  return {
    geometries,
    error,
    dismissError: useCallback(() => setError(null), []),
    setOnly,
    add,
    place,
    transform,
    layFlat,
    remeasure,
  };
}
