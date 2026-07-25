/**
 * Process and filament presets — two lists whose sizes differ by two orders of magnitude.
 *
 * **Process** for a printer + nozzle is ~7 presets. Nothing clever is needed: show them.
 *
 * **Filament** for the same printer is **392 presets / 1.3 MB**, because Orca offers the
 * whole `OrcaFilamentLibrary` for every machine alongside the vendor's own. Three things
 * make that thumb-usable, in the order a user meets them:
 *
 *  1. **Suggested first.** The printer model's own `defaultMaterials` — 8 presets for a
 *     Bambu H2S — pinned to the top. Most sessions end here, with no typing at all.
 *  2. **Material chips.** One tap narrows 392 to the ~100 PLA entries. Chips are derived
 *     from `filament_type` in the resolved presets, most common first.
 *  3. **Search**, matching every term anywhere in the name/material/vendor, so
 *     "pla basic" finds "Bambu PLA Basic @BBL H2S".
 *
 * The list is fetched once and filtered in the browser: the endpoint is static per Orca
 * version and ETag-cacheable, and a request per keystroke on mobile data would be worse
 * in every way.
 */

import { useMemo, useState } from 'react';
import type { ApiError } from '@orca-web/shared';
import { materialsOf, searchPresets, suggestedPresets, type PresetOption } from '../api/catalog.ts';
import { Chip, ErrorNotice, OptionRow, SearchField, Sheet, Spinner } from './primitives.tsx';

export function PresetPicker({
  kind,
  presets,
  loading,
  error,
  onRetry,
  defaultMaterials,
  selectedId,
  onSelect,
  onClose,
  subtitle,
}: {
  kind: 'process' | 'filament';
  presets: readonly PresetOption[];
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  defaultMaterials: readonly string[];
  selectedId: string | null;
  onSelect: (preset: PresetOption) => void;
  onClose: () => void;
  subtitle: string;
}) {
  const [query, setQuery] = useState('');
  const [material, setMaterial] = useState<string | null>(null);

  const materials = useMemo(
    () => (kind === 'filament' ? materialsOf(presets) : []),
    [kind, presets],
  );
  const suggested = useMemo(
    () => (kind === 'filament' ? suggestedPresets(presets, defaultMaterials) : []),
    [kind, presets, defaultMaterials],
  );
  const filtered = useMemo(
    () => searchPresets(presets, query, material),
    [presets, query, material],
  );

  const filtering = query.trim() !== '' || material !== null;
  const showSuggested = suggested.length > 0 && !filtering;
  const suggestedIds = new Set(suggested.map((preset) => preset.id));
  const rest = showSuggested ? filtered.filter((preset) => !suggestedIds.has(preset.id)) : filtered;

  const title = kind === 'process' ? 'Quality' : 'Filament';

  return (
    <Sheet
      title={title}
      subtitle={loading ? subtitle : `${presets.length} presets · ${subtitle}`}
      onClose={onClose}
      testId={`${kind}-picker`}
      toolbar={
        presets.length > 12 ? (
          <div className="space-y-2">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={`Search ${title.toLowerCase()} presets`}
              testId={`${kind}-search`}
            />
            {materials.length > 1 ? (
              // The chip strip is the one horizontally scrolling thing in the app; it is
              // inside its own overflow container so the page itself never scrolls
              // sideways at 390px.
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                <Chip label="All" selected={material === null} onClick={() => setMaterial(null)} />
                {materials.map((candidate) => (
                  <Chip
                    key={candidate}
                    label={candidate}
                    selected={material === candidate}
                    onClick={() => setMaterial(material === candidate ? null : candidate)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {error ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : loading ? (
        <Spinner label={`Loading ${title.toLowerCase()} presets…`} />
      ) : (
        <>
          {showSuggested ? (
            <section className="mb-4">
              <h3 className="mb-2 px-1 text-xs tracking-wide text-muted uppercase">
                Suggested for this printer
              </h3>
              <ul className="space-y-2">
                {suggested.map((preset) => (
                  <li key={preset.id}>
                    <OptionRow
                      name={preset.name}
                      detail={preset.detail}
                      selected={preset.id === selectedId}
                      onClick={() => onSelect(preset)}
                      testId={`preset-${preset.id}`}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {rest.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">
              {filtering ? 'Nothing matches that filter.' : 'No presets for this printer.'}
            </p>
          ) : (
            <section>
              {showSuggested ? (
                <h3 className="mb-2 px-1 text-xs tracking-wide text-muted uppercase">
                  All {rest.length} presets
                </h3>
              ) : null}
              <ul className="space-y-2">
                {rest.map((preset) => (
                  <li key={preset.id}>
                    <OptionRow
                      name={preset.name}
                      detail={preset.detail}
                      selected={preset.id === selectedId}
                      onClick={() => onSelect(preset)}
                      testId={`preset-${preset.id}`}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Sheet>
  );
}
