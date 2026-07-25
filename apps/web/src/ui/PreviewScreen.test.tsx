/**
 * The preview screen without a GPU.
 *
 * jsdom has no WebGL, so `PreviewScene`'s constructor throws and the screen takes its
 * "this browser cannot show 3D" path. That is exactly what makes this test useful: the
 * controls either work without the canvas or they are wired to it, and the second would be
 * a screen that is unusable on any browser with WebGL blocklisted — which on Android is
 * not rare. Pixels, touch targets and the memory budget are measured for real in Chromium
 * by `test/e2e/preview.mjs`; what is checked here is the contract between the index and
 * the controls.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BedSpec } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import { PreviewScreen } from './PreviewScreen.tsx';

const BED: BedSpec = {
  printerModel: 'Bambu Lab X1 Carbon',
  preset: { kind: 'machine', vendor: 'BBL', name: 'Bambu Lab X1 Carbon 0.4 nozzle' },
  printableArea: [
    [0, 0],
    [256, 0],
    [256, 256],
    [0, 256],
  ],
  printableHeight: 250,
  excludeArea: [],
  // MEASURED on a stock X1C, SPEC deviation #15.
  extruderOffset: [0, 2],
};

/** 1 prime-line layer + 40 object layers, shaped like the real index. */
function index(): PreviewIndex {
  const counts = [105, ...Array.from({ length: 40 }, () => 500)];
  const offset: number[] = [];
  let running = 0;
  for (const count of counts) {
    offset.push(running);
    running += count * 18;
  }
  return {
    format: 'orca-web.gcode-preview',
    version: 1,
    endianness: 'little',
    segmentBytes: 18,
    source: {
      gcode: 'plate_1.gcode',
      plate: 1,
      bytes: running,
      firstObjectLayer: 1,
      headerLayerCount: 40,
      nozzleDiameter: 0.4,
      filamentColours: ['#F2754E'],
    },
    quantisation: { origin: [0, 0, 0], scale: [0.003, 0.003, 0.001] },
    bounds: { min: [80, 80, 0.2], max: [170, 170, 8] },
    features: ['Unknown', 'Custom', 'Outer wall', 'Inner wall', 'Overhang wall', 'Sparse infill'],
    tools: 1,
    stats: {
      layers: counts.length,
      segments: counts.reduce((a, b) => a + b, 0),
      bytes: running,
      arcs: 0,
      arcSegments: 0,
      arcsUnsupportedPlane: 0,
      segmentsWithoutFeature: 0,
      unparsedLines: 0,
      parseMs: 12,
    },
    layers: {
      z: counts.map((_, layer) => (layer === 0 ? 0.3 : 0.2 * layer)),
      height: counts.map(() => 0.2),
      count: counts,
      offset,
      featureMask: counts.map((_, layer) => (layer === 0 ? 1 << 1 : (1 << 2) | (1 << 5))),
    },
  };
}

beforeEach(() => {
  // jsdom's `getContext` is a stub that logs "Not implemented" to the virtual console for
  // every call. Returning null instead makes `WebGLRenderer` fail the way a browser with
  // WebGL blocklisted does — which is the path under test — without the noise.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/preview/1')) {
        return new Response(JSON.stringify(index()), {
          headers: { 'content-type': 'application/json' },
        });
      }
      // The layer data is never reached: without WebGL there is no scene to build into.
      return new Response(new ArrayBuffer(0), { status: 206 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('PreviewScreen', () => {
  it('spans the object layers, not the machine’s prime line', async () => {
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    const slider = (await screen.findByTestId('preview-layer')) as HTMLInputElement;
    // Layer 0 is a 585 mm priming pass at a Z *above* layer 1 (SPEC deviation #20), so the
    // slider must not be able to land on it: `layers.z` only sorts from layer 1 on.
    expect(slider.min).toBe('1');
    expect(slider.max).toBe('40');
    // Opens in the middle, where walls and infill are both visible.
    expect(Number(slider.value)).toBe(21);
    expect(screen.getByTestId('preview-layer-label').textContent).toContain('Layer 21 of 40');
  });

  it('steps one layer at a time, because a thumb on 390px cannot', async () => {
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    const slider = (await screen.findByTestId('preview-layer')) as HTMLInputElement;
    fireEvent.click(screen.getByTestId('preview-layer-up'));
    expect(Number(slider.value)).toBe(22);
    fireEvent.click(screen.getByTestId('preview-layer-down'));
    fireEvent.click(screen.getByTestId('preview-layer-down'));
    expect(Number(slider.value)).toBe(20);
  });

  it('reports a window rather than the model, and reaches the bottom without stalling', async () => {
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    await screen.findByTestId('preview-layer');
    const stats = screen.getByTestId('preview-stats');
    expect(Number(stats.dataset.last) - Number(stats.dataset.first) + 1).toBe(20);

    // At the bottom of the print the window swallows the prime line, which is contiguous
    // with layer 1 in the `.bin` and is real deposited material.
    fireEvent.change(screen.getByTestId('preview-layer'), { target: { value: '3' } });
    await waitFor(() => expect(screen.getByTestId('preview-stats').dataset.first).toBe('0'));
  });

  it('shows the deviation-#15 offset it is applying', async () => {
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    await screen.findByTestId('preview-stats');
    expect(screen.getByTestId('preview-stats').dataset.extruderOffset).toBe('0,2');
  });

  it('warns when there is no printer, because then the offset is unknown', async () => {
    render(<PreviewScreen jobId="job" bed={null} onClose={vi.fn()} />);
    await screen.findByTestId('preview-stats');
    expect(screen.getByTestId('preview-stats').dataset.extruderOffset).toBe('0,0');
    expect(screen.getByText(/toolpath may sit a couple of millimetres/i)).toBeTruthy();
  });

  it('lists the feature types the window contains, from the index alone', async () => {
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    const legend = await screen.findByTestId('preview-legend');
    // `featureMask` is in the index, so the legend is right before a byte of segment data
    // has arrived — which is what makes it useful while scrubbing.
    expect(legend.textContent).toContain('Outer wall');
    expect(legend.textContent).toContain('Sparse infill');
    expect(legend.textContent).not.toContain('Overhang wall');
  });

  it('offers both colour modes', async () => {
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    await screen.findByTestId('preview-colour-feature');
    const byTool = screen.getByTestId('preview-colour-tool');
    fireEvent.click(byTool);
    expect(byTool.getAttribute('aria-selected')).toBe('true');
    // The tool palette is the slice's own `filament_colour`, not a guess.
    expect(screen.getByTestId('preview-legend').textContent).toContain('Tool 1');
  });

  it('surfaces a failed index rather than a blank screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: 'There is no job job.', retryable: false },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    render(<PreviewScreen jobId="job" bed={BED} onClose={vi.fn()} />);
    expect(await screen.findByText('There is no job job.')).toBeTruthy();
  });
});
