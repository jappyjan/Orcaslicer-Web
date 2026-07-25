/**
 * Component tests for the two pickers that have to survive the catalog's real sizes:
 * 384 printer models and 392 filament presets.
 *
 * jsdom cannot tell us anything about pixels — the 390px layout and the 44px touch
 * targets are asserted for real in a Chromium run against the running container (see the
 * M3 notes in README.md). What is checked here is the behaviour that makes those lists
 * navigable at all.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCatalog, type PresetOption } from '../api/catalog.ts';
import { PresetPicker } from './PresetPicker.tsx';
import { PrinterPicker } from './PrinterPicker.tsx';

afterEach(() => {
  document.body.innerHTML = '';
});

/** 40 vendors × 10 models = 400 printers, i.e. the real catalog's order of magnitude. */
function bigCatalog() {
  const vendors = Array.from({ length: 40 }, (_, v) => ({
    id: `V${v}`,
    name: `Vendor ${v}`,
    printerModels: [],
  }));
  const printerModels = vendors.flatMap((vendor, v) =>
    Array.from({ length: 10 }, (_, m) => ({
      id: `${vendor.id}/Model ${v}-${m}`,
      name: `Model ${v}-${m}`,
      vendor: vendor.id,
      advertisedNozzleDiameters: [0.4],
      nozzleVariants: [
        {
          variant: '0.4',
          nozzleDiameter: 0.4,
          machinePresetId: `${vendor.id}/machine/Model ${v}-${m} 0.4 nozzle`,
          machinePresetName: `Model ${v}-${m} 0.4 nozzle`,
        },
      ],
      defaultMaterials: [],
      file: '',
    })),
  );
  return buildCatalog({
    orcaVersion: '2.4.2',
    generatedAt: '',
    counts: { vendors: 40, printerModels: 400, presets: 0 },
    vendors,
    printerModels,
  });
}

describe('PrinterPicker', () => {
  it('shows brands first, not 400 printers', () => {
    const catalog = bigCatalog();
    render(
      <PrinterPicker catalog={catalog} selectedId={null} onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    const rows = screen.getAllByRole('button', { pressed: false });
    // 40 vendors + Close. Emphatically not 400 model rows.
    expect(rows.filter((row) => row.dataset.testid?.startsWith('vendor-'))).toHaveLength(40);
    expect(screen.queryByTestId('printer-V3/Model 3-1')).toBeNull();
  });

  it('drills into a brand and back out', () => {
    const catalog = bigCatalog();
    const onSelect = vi.fn();
    render(
      <PrinterPicker catalog={catalog} selectedId={null} onSelect={onSelect} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('vendor-V3'));
    expect(screen.getAllByTestId(/^printer-V3\//)).toHaveLength(10);

    fireEvent.click(screen.getByText('‹ Back'));
    expect(screen.getByTestId('vendor-V3')).toBeTruthy();
  });

  it('searches across every vendor at once, because nobody knows their vendor code', () => {
    const catalog = bigCatalog();
    const onSelect = vi.fn();
    render(
      <PrinterPicker catalog={catalog} selectedId={null} onSelect={onSelect} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('printer-search'), { target: { value: 'model 7-2' } });
    const result = screen.getByTestId('printer-V7/Model 7-2');
    // The vendor is on the row, so two similarly named models stay distinguishable.
    expect(within(result).getByText(/Vendor 7/)).toBeTruthy();

    fireEvent.click(result);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Model 7-2' }));
  });
});

describe('PresetPicker', () => {
  /** 392 filaments, the real number for a Bambu H2S 0.4. */
  const filaments: PresetOption[] = Array.from({ length: 392 }, (_, i) => ({
    id: `lib/filament/Filament ${i}`,
    name: `Filament ${i}`,
    vendor: i < 109 ? 'BBL' : 'OrcaFilamentLibrary',
    detail: i % 3 === 0 ? 'PLA' : i % 3 === 1 ? 'PETG' : 'TPU',
    material: i % 3 === 0 ? 'PLA' : i % 3 === 1 ? 'PETG' : 'TPU',
    layerHeight: null,
    haystack: `filament ${i}`,
  }));

  function renderFilaments(onSelect = vi.fn()) {
    render(
      <PresetPicker
        kind="filament"
        presets={filaments}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        defaultMaterials={['Filament 3', 'Filament 6']}
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
        subtitle="Bambu Lab H2S 0.4 mm"
      />,
    );
    return onSelect;
  }

  it("pins the printer vendor's suggestions above the 392-entry list", () => {
    renderFilaments();
    expect(screen.getByText('Suggested for this printer')).toBeTruthy();
    const suggested = screen.getByText('Suggested for this printer').parentElement;
    expect(within(suggested as HTMLElement).getAllByRole('button')).toHaveLength(2);
    // …and they are not repeated further down.
    expect(screen.getByText('All 390 presets')).toBeTruthy();
  });

  it('narrows by material chip with one tap', () => {
    renderFilaments();
    fireEvent.click(screen.getByRole('button', { name: 'PETG' }));
    // Chips replace the suggested section, because the user is now filtering explicitly.
    expect(screen.queryByText('Suggested for this printer')).toBeNull();
    expect(screen.getAllByTestId(/^preset-/)).toHaveLength(
      filaments.filter((preset) => preset.material === 'PETG').length,
    );
  });

  it('searches by name', () => {
    const onSelect = renderFilaments();
    fireEvent.change(screen.getByTestId('filament-search'), { target: { value: 'filament 391' } });
    const rows = screen.getAllByTestId(/^preset-/);
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Filament 391' }));
  });

  it('offers no search box for a 7-preset process list', () => {
    render(
      <PresetPicker
        kind="process"
        presets={filaments.slice(0, 7)}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        defaultMaterials={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        subtitle="Bambu Lab H2S 0.4 mm"
      />,
    );
    expect(screen.queryByTestId('process-search')).toBeNull();
    expect(screen.getAllByTestId(/^preset-/)).toHaveLength(7);
  });

  it('shows the API error verbatim, with its hint and a retry when retryable', () => {
    // The 404 for an unknown nozzle puts the real nozzle list in `hint`; swallowing it
    // would throw away the only actionable part of the response.
    const onRetry = vi.fn();
    render(
      <PresetPicker
        kind="filament"
        presets={[]}
        loading={false}
        error={{
          code: 'NOT_FOUND',
          message: '"Bambu Lab H2S" has no 0.3 mm nozzle variant',
          hint: 'Available nozzles: 0.2, 0.4, 0.6, 0.8.',
          retryable: true,
        }}
        onRetry={onRetry}
        defaultMaterials={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        subtitle=""
      />,
    );
    expect(screen.getByText('"Bambu Lab H2S" has no 0.3 mm nozzle variant')).toBeTruthy();
    expect(screen.getByText('Available nozzles: 0.2, 0.4, 0.6, 0.8.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('error-retry'));
    expect(onRetry).toHaveBeenCalled();
  });
});
