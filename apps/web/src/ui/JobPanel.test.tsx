/**
 * The progress and results panels, driven by the event sequence a real cube produces.
 *
 * The panel now lives in the workspace dock rather than on a screen of its own, which is
 * a layout change and deliberately not a behaviour one: everything asserted here — the
 * indeterminate bar before the first number, the quiet-gap reassurance, the four stats,
 * both downloads — is the same contract M3 shipped.
 */

import type { JobSummary } from '@orca-web/shared';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialProgress, QUIET_AFTER_MS, reduceProgress } from '../state/progress.ts';
import { JobPanel } from './JobPanel.tsx';

afterEach(() => {
  document.body.innerHTML = '';
});

const T0 = 1_000_000;

function view(model: Parameters<typeof JobPanel>[0]['model'], now = T0) {
  render(
    <JobPanel
      model={model}
      now={now}
      onCancel={vi.fn()}
      onSliceAgain={vi.fn()}
      onDismiss={vi.fn()}
      cancelling={false}
    />,
  );
}

const DONE_JOB: JobSummary = {
  id: 'job-1',
  name: 'cube20.stl',
  state: 'succeeded',
  createdAt: '',
  startedAt: '',
  finishedAt: '',
  percent: 100,
  message: 'All done, Success',
  warnings: [],
  models: [],
  // Both downloads, exactly as the API publishes them.
  artifacts: [
    {
      name: 'result.gcode.3mf',
      bytes: 58564,
      contentType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      role: 'project',
    },
    { name: 'plate_1.gcode', bytes: 350290, contentType: 'text/x.gcode', role: 'gcode', plate: 1 },
  ],
  stats: {
    predictionSeconds: 873,
    weightGrams: 3.66,
    totalMetres: 1.21,
    layerCount: 100,
    plates: [
      {
        index: 1,
        predictionSeconds: 873,
        weightGrams: 3.66,
        layerCount: 100,
        filaments: [{ id: 1, type: 'PLA', colour: '#F2754E', usedMetres: 1.21, usedGrams: 3.66 }],
        outside: false,
        supportUsed: false,
      },
    ],
  },
  error: null,
};

describe('JobPanel', () => {
  it('shows no percentage before the first real number', () => {
    const queued = reduceProgress(
      initialProgress(T0),
      { type: 'state', jobId: 'j', state: 'queued', at: '' },
      T0,
    );
    view(queued);
    expect(screen.getByTestId('progress-panel').dataset.barState).toBe('indeterminate');
    expect(screen.queryByTestId('job-percent')).toBeNull();
    expect(screen.getByTestId('job-state').textContent).toBe('Waiting for a slot');
  });

  it('reassures rather than looking stalled during a long gap', () => {
    const running = reduceProgress(
      initialProgress(T0),
      {
        type: 'progress',
        jobId: 'j',
        percent: 70,
        plateIndex: 1,
        plateCount: 1,
        platePercent: 75,
        message: 'Optimizing toolpath',
        warning: null,
        at: '',
      },
      T0,
    );
    view(running, T0 + QUIET_AFTER_MS);
    expect(screen.getByTestId('job-percent').textContent).toBe('70%');
    expect(screen.getByTestId('job-quiet')).toBeTruthy();
  });

  it('keeps warnings visible on the results panel', () => {
    let model = reduceProgress(
      initialProgress(T0),
      {
        type: 'progress',
        jobId: 'j',
        percent: 70,
        plateIndex: 1,
        plateCount: 1,
        platePercent: 70,
        message: 'Generating supports',
        warning: 'Object has unsupported overhangs',
        at: '',
      },
      T0,
    );
    model = reduceProgress(model, { type: 'done', jobId: 'j', job: DONE_JOB, at: '' }, T0);
    view(model);
    expect(screen.getByTestId('warnings').textContent).toContain('unsupported overhangs');
  });

  it('renders the four stats the spec asks for, and offers both downloads', () => {
    const model = reduceProgress(
      initialProgress(T0),
      { type: 'done', jobId: 'j', job: DONE_JOB, at: '' },
      T0,
    );
    view(model);

    expect(screen.getByTestId('stat-time').textContent).toBe('14 min 33 s');
    expect(screen.getByTestId('stat-grams').textContent).toBe('3.66 g');
    expect(screen.getByTestId('stat-metres').textContent).toBe('1.21 m');
    expect(screen.getByTestId('stat-layers').textContent).toBe('100');

    const project = screen.getByTestId('download-project') as HTMLAnchorElement;
    const gcode = screen.getByTestId('download-gcode') as HTMLAnchorElement;
    expect(project.getAttribute('href')).toBe('/jobs/job-1/artifacts/result.gcode.3mf');
    expect(gcode.getAttribute('href')).toBe('/jobs/job-1/artifacts/plate_1.gcode');
    expect(project.hasAttribute('download')).toBe(true);
  });

  it('never surfaces first_layer_time', () => {
    // SPEC verified deviation #6: it is uninitialised garbage and the API does not
    // expose it. This test exists so nobody adds it back from the raw slice report.
    const model = reduceProgress(
      initialProgress(T0),
      { type: 'done', jobId: 'j', job: DONE_JOB, at: '' },
      T0,
    );
    view(model);
    expect(document.body.textContent).not.toMatch(/first layer/i);
  });

  it('shows a failure with its hint and no retry when the API says it is not retryable', () => {
    const model = reduceProgress(
      initialProgress(T0),
      {
        type: 'failed',
        jobId: 'j',
        error: {
          code: 'OBJECT_OUTSIDE_BED',
          message: 'The model does not fit on the build plate.',
          hint: 'Scale it down or choose a larger printer.',
          retryable: false,
        },
        at: '',
      },
      T0,
    );
    view(model);
    expect(screen.getByTestId('job-error').textContent).toContain('does not fit');
    expect(screen.getByTestId('job-error').textContent).toContain('Scale it down');
    expect(screen.queryByTestId('error-retry')).toBeNull();
    // A finished job offers the way forward, not a Cancel button.
    expect(screen.queryByTestId('cancel-button')).toBeNull();
    expect(screen.getByTestId('slice-again-button')).toBeTruthy();
  });
});
