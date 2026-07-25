/**
 * The progress model — pure, so the awkward parts are testable.
 *
 * SPEC verified deviation #10, measured against the pinned binary:
 *
 * > The progress pipe usually omits `warning` entirely rather than sending `null`, and
 * > emits far fewer lines than you would expect — 9 for a cube, starting around 35 %.
 * > Do not build UI that assumes a smooth 0→100 ramp.
 *
 * Re-measured while building this milestone: a 20 mm cube on a Bambu H2S produced
 * exactly **two** progress frames, the first at **70 %**. So the UI must not treat
 * "no number yet" as "nothing is happening", must not treat a long gap as a stall, and
 * must never let the bar go backwards when a multi-plate job restarts `plate_percent`.
 *
 * The rules encoded here:
 *
 *  1. `determinate` stays false until the first `progress` frame carrying a number. Until
 *     then the bar is an indeterminate sweep, not 0 %.
 *  2. `percent` is monotonic. `plate_percent` restarts per plate and `total_percent` has
 *     been seen to jump; a bar that goes backwards reads as a bug.
 *  3. `quiet` becomes true after {@link QUIET_AFTER_MS} without a frame while running.
 *     The UI keeps animating and says the slicer is still working, because with nine
 *     frames per job a 20-second silence is normal, not a hang.
 *  4. Warnings accumulate and are de-duplicated. They are the user's only signal for
 *     things like unsupported overhangs, so they are never replaced by a later frame and
 *     never dropped when the job finishes.
 */

import type { ApiError, JobEvent, JobState, JobSummary } from '@orca-web/shared';

/** How long a gap in the progress stream is normal before we say so. */
export const QUIET_AFTER_MS = 6000;

export interface ProgressModel {
  state: JobState | 'submitting';
  /** False until a real number has arrived; drive an indeterminate bar while it is. */
  determinate: boolean;
  /** 0–100, monotonic. */
  percent: number;
  message: string | null;
  plateIndex: number;
  plateCount: number;
  warnings: string[];
  /** Epoch ms of the last frame of any kind. */
  updatedAt: number;
  startedAt: number;
  /** Set on the terminal `done` event. */
  job: JobSummary | null;
  error: ApiError | null;
  /** True when the SSE stream failed and polling took over. */
  degraded: boolean;
}

export function initialProgress(now: number): ProgressModel {
  return {
    state: 'submitting',
    determinate: false,
    percent: 0,
    message: null,
    plateIndex: 0,
    plateCount: 0,
    warnings: [],
    updatedAt: now,
    startedAt: now,
    job: null,
    error: null,
    degraded: false,
  };
}

function withWarning(warnings: readonly string[], warning: string | null | undefined): string[] {
  // The pipe usually omits `warning` rather than sending null, so both shapes arrive.
  if (warning === null || warning === undefined || warning.trim() === '') return [...warnings];
  return warnings.includes(warning) ? [...warnings] : [...warnings, warning];
}

export function reduceProgress(model: ProgressModel, event: JobEvent, now: number): ProgressModel {
  switch (event.type) {
    case 'state':
      return { ...model, state: event.state, updatedAt: now };

    case 'progress': {
      const percent = Number.isFinite(event.percent) ? event.percent : model.percent;
      return {
        ...model,
        state: model.state === 'submitting' || model.state === 'queued' ? 'running' : model.state,
        determinate: true,
        // Rule 2: monotonic, clamped.
        percent: Math.min(100, Math.max(model.percent, percent)),
        message: event.message === '' ? model.message : event.message,
        plateIndex: event.plateIndex,
        plateCount: event.plateCount,
        warnings: withWarning(model.warnings, event.warning),
        updatedAt: now,
      };
    }

    case 'done':
      return {
        ...model,
        state: 'succeeded',
        determinate: true,
        percent: 100,
        message: event.job.message ?? model.message,
        // Rule 4: the job summary's warnings are the authoritative set; merge rather than
        // replace, because a warning seen on the wire must not vanish from the results.
        warnings: event.job.warnings.reduce(
          (acc, warning) => withWarning(acc, warning),
          model.warnings,
        ),
        job: event.job,
        updatedAt: now,
      };

    case 'failed':
      return { ...model, state: 'failed', error: event.error, updatedAt: now };

    default:
      return model;
  }
}

export function isActive(model: ProgressModel): boolean {
  return model.state === 'submitting' || model.state === 'queued' || model.state === 'running';
}

/** Rule 3: a long gap while running is expected, but the UI has to say something. */
export function isQuiet(model: ProgressModel, now: number): boolean {
  return model.state === 'running' && now - model.updatedAt >= QUIET_AFTER_MS;
}

/**
 * What the bar should show.
 *
 * `indeterminate` covers both "no number yet" and "queued", which is the state a phone
 * user sees most often on a busy server.
 */
export function barState(model: ProgressModel): 'indeterminate' | 'determinate' | 'complete' {
  if (model.state === 'succeeded') return 'complete';
  if (!model.determinate || model.state === 'queued' || model.state === 'submitting') {
    return 'indeterminate';
  }
  return 'determinate';
}
