/**
 * Driving `SlicerEngine.slice()`.
 *
 * `for await (const p of gen)` throws the generator's return value away, and the
 * return value is precisely the artefacts. So every caller goes through this helper
 * instead, which pumps the iterator by hand and hands back both halves.
 */

import type {
  SliceArtifacts,
  SliceJob,
  SliceOptions,
  SliceProgress,
  SlicerEngine,
} from './port.js';

export type ProgressSink = (progress: SliceProgress) => void | Promise<void>;

export async function runSlice(
  engine: SlicerEngine,
  job: SliceJob,
  options: SliceOptions,
  onProgress: ProgressSink,
): Promise<SliceArtifacts> {
  const iterator = engine.slice(job, options);
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) return step.value;
      await onProgress(step.value);
    }
  } catch (error) {
    // Give the adapter a chance to tear down (kill the child, close the pipe) even when
    // the failure came from the progress sink rather than from the engine.
    await iterator.return(undefined as never).catch(() => undefined);
    throw error;
  }
}
