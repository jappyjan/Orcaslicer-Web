/**
 * Regression tests for SPEC verified deviation #10 — the progress pipe emits few lines,
 * starting late, usually without `warning` at all.
 *
 * These are the behaviours that make the difference between a progress UI that looks
 * broken and one that does not, so each case names the measurement it defends.
 */

import type { JobEvent, JobSummary } from '@orca-web/shared';
import { describe, expect, it } from 'vitest';
import {
  barState,
  initialProgress,
  isQuiet,
  QUIET_AFTER_MS,
  reduceProgress,
  type ProgressModel,
} from './progress.ts';

const T0 = 1_000_000;

function progress(overrides: Partial<Extract<JobEvent, { type: 'progress' }>> = {}): JobEvent {
  return {
    type: 'progress',
    jobId: 'j1',
    percent: 70,
    plateIndex: 1,
    plateCount: 1,
    platePercent: 75,
    message: 'Optimizing toolpath',
    warning: null,
    at: new Date(T0).toISOString(),
    ...overrides,
  };
}

function summary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'j1',
    name: 'cube20.stl',
    state: 'succeeded',
    createdAt: '',
    startedAt: '',
    finishedAt: '',
    percent: 100,
    message: 'All done, Success',
    warnings: [],
    models: [],
    artifacts: [],
    stats: null,
    error: null,
    ...overrides,
  };
}

function run(events: JobEvent[], start = T0): ProgressModel {
  return events.reduce(
    (model, event, index) => reduceProgress(model, event, start + index * 100),
    initialProgress(start),
  );
}

describe('progress model', () => {
  it('stays indeterminate until a real number arrives', () => {
    // Measured on the pinned binary: a 20 mm cube emitted its FIRST progress frame at
    // 70 %. Rendering 0 % until then would be a lie and would look stalled.
    const queued = run([{ type: 'state', jobId: 'j1', state: 'queued', at: '' }]);
    expect(barState(queued)).toBe('indeterminate');

    const running = run([{ type: 'state', jobId: 'j1', state: 'running', at: '' }]);
    expect(running.determinate).toBe(false);
    expect(barState(running)).toBe('indeterminate');

    const withNumber = reduceProgress(running, progress(), T0);
    expect(withNumber.determinate).toBe(true);
    expect(barState(withNumber)).toBe('determinate');
    expect(withNumber.percent).toBe(70);
  });

  it('never lets the bar go backwards', () => {
    // total_percent has been observed to jump, and plate_percent restarts per plate.
    const model = run([
      progress({ percent: 70 }),
      progress({ percent: 35, plateIndex: 2, plateCount: 2 }),
    ]);
    expect(model.percent).toBe(70);
    expect(model.plateIndex).toBe(2);
  });

  it('clamps to 100', () => {
    expect(run([progress({ percent: 140 })]).percent).toBe(100);
  });

  it('treats a long gap as normal but visible', () => {
    const model = run([{ type: 'state', jobId: 'j1', state: 'running', at: '' }, progress()]);
    expect(isQuiet(model, model.updatedAt + QUIET_AFTER_MS - 1)).toBe(false);
    expect(isQuiet(model, model.updatedAt + QUIET_AFTER_MS)).toBe(true);
    // ...but only while running: a finished job is not "quiet", it is finished.
    const done = reduceProgress(model, { type: 'done', jobId: 'j1', job: summary(), at: '' }, T0);
    expect(isQuiet(done, T0 + 10 * QUIET_AFTER_MS)).toBe(false);
  });

  it('collects warnings, de-duplicated, and keeps them after the job ends', () => {
    // The pipe usually OMITS `warning` rather than sending null, so both shapes appear.
    const model = run([
      progress({ warning: 'Object exceeds the printable area' }),
      progress({ warning: 'Object exceeds the printable area' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the wire omits the key entirely
      progress({ warning: undefined as any }),
      progress({ warning: 'Support may be needed' }),
    ]);
    expect(model.warnings).toEqual(['Object exceeds the printable area', 'Support may be needed']);

    const done = reduceProgress(
      model,
      { type: 'done', jobId: 'j1', job: summary({ warnings: ['Support may be needed'] }), at: '' },
      T0,
    );
    // Merged, not replaced: a warning seen on the wire must not vanish from the results.
    expect(done.warnings).toEqual(['Object exceeds the printable area', 'Support may be needed']);
  });

  it('completes on done and fails on failed', () => {
    const done = run([progress(), { type: 'done', jobId: 'j1', job: summary(), at: '' }]);
    expect(done.state).toBe('succeeded');
    expect(done.percent).toBe(100);
    expect(barState(done)).toBe('complete');
    expect(done.job?.message).toBe('All done, Success');

    const failed = run([
      progress(),
      {
        type: 'failed',
        jobId: 'j1',
        error: { code: 'SLICING_FAILED', message: 'Slicing failed.', retryable: true },
        at: '',
      },
    ]);
    expect(failed.state).toBe('failed');
    expect(failed.error?.message).toBe('Slicing failed.');
  });

  it('promotes a queued job to running on the first progress frame', () => {
    // The engine can emit progress before the state event lands; the UI must not still
    // be saying "waiting for a slot" while percentages arrive.
    const model = run([{ type: 'state', jobId: 'j1', state: 'queued', at: '' }, progress()]);
    expect(model.state).toBe('running');
  });
});
