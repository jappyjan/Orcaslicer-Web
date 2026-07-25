/**
 * Choosing one of **384 printer models** with a thumb.
 *
 * A 384-row `<select>` is unusable on a phone and a flat 384-row list is not much
 * better, so this is a two-level drill-down with search over the top:
 *
 *  - **Level 1** is the 65 vendors, shown by *display* name (`BBL` → `Bambulab`), each
 *    with its printer count. That is the one list short enough to scan by eye.
 *  - **Level 2** is that vendor's printers — 1 to 41 rows, which is a normal list.
 *  - **Typing** abandons the hierarchy and searches every model at once, because someone
 *    who knows they own an "X1 Carbon" should not have to know Bambu Lab's vendor code.
 *    Results carry the vendor name as their second line so two similarly named models
 *    from different vendors stay distinguishable.
 */

import { useMemo, useState } from 'react';
import { searchPrinters, type Catalog, type PrinterOption } from '../api/catalog.ts';
import { OptionRow, SearchField, Sheet } from './primitives.tsx';

export function PrinterPicker({
  catalog,
  selectedId,
  onSelect,
  onClose,
}: {
  catalog: Catalog;
  selectedId: string | null;
  onSelect: (printer: PrinterOption) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [vendorId, setVendorId] = useState<string | null>(null);

  const searching = query.trim() !== '';
  const results = useMemo(
    () => (searching ? searchPrinters(catalog.printers, query) : []),
    [catalog.printers, query, searching],
  );
  const vendor = catalog.vendors.find((candidate) => candidate.id === vendorId) ?? null;

  const title = searching ? 'Search printers' : (vendor?.name ?? 'Printer');
  const subtitle = searching
    ? `${results.length} of ${catalog.printers.length} models`
    : vendor
      ? `${vendor.printers.length} models`
      : `${catalog.vendors.length} brands · ${catalog.printers.length} models`;

  return (
    <Sheet
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      onBack={!searching && vendor ? () => setVendorId(null) : undefined}
      testId="printer-picker"
      toolbar={
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search all printers"
          testId="printer-search"
        />
      }
    >
      {searching ? (
        results.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No printer matches “{query}”. Try the brand name, or part of the model.
          </p>
        ) : (
          <ul className="space-y-2">
            {results.map((printer) => (
              <li key={printer.id}>
                <OptionRow
                  name={printer.name}
                  detail={`${printer.vendorName} · ${printer.nozzles.length} nozzle${
                    printer.nozzles.length === 1 ? '' : 's'
                  }`}
                  selected={printer.id === selectedId}
                  onClick={() => onSelect(printer)}
                  testId={`printer-${printer.id}`}
                />
              </li>
            ))}
          </ul>
        )
      ) : vendor ? (
        <ul className="space-y-2">
          {vendor.printers.map((printer) => (
            <li key={printer.id}>
              <OptionRow
                name={printer.name}
                detail={printer.nozzles.map((nozzle) => `${nozzle.variant} mm`).join(' · ')}
                selected={printer.id === selectedId}
                onClick={() => onSelect(printer)}
                testId={`printer-${printer.id}`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2">
          {catalog.vendors.map((candidate) => (
            <li key={candidate.id}>
              <OptionRow
                name={candidate.name}
                detail={`${candidate.printers.length} printer${
                  candidate.printers.length === 1 ? '' : 's'
                }`}
                selected={candidate.printers.some((printer) => printer.id === selectedId)}
                onClick={() => setVendorId(candidate.id)}
                testId={`vendor-${candidate.id}`}
              />
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
