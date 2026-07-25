/**
 * The generated settings UI (M6).
 *
 * ## The problem
 *
 * `PrintConfig.cpp` defines 751 options. 31 are upstream's hidden `develop` tier, 76 are
 * SLA, one (`extruder_printable_area`) has no renderable shape — that still leaves ~640
 * fields for a 390 px column. A desktop settings tree ported to a phone is exactly the
 * "mouse-shaped UI" the brief says to cut, so the list is never the thing you navigate.
 *
 * ## The information architecture
 *
 * Four tools, in the order a person reaches for them:
 *
 *  1. **Search.** The fastest path to a known setting, and the only workable one for the
 *     long tail. Matches label, key, group and tooltip; every term must match, in any
 *     order. This is why the key is printed under every field — someone who knows
 *     `layer_height` should not have to guess what Orca calls it.
 *  2. **Disclosure level.** `simple ⊂ advanced ⊂ expert`, mirroring `ConfigOptionMode`.
 *     Simple is 186 options; that is the difference between a list and a haystack, and it
 *     is upstream's own judgement about which ones matter rather than ours.
 *  3. **Group drill-down.** One category at a time, full-screen, with a Back row — never
 *     a tree with expandable nodes, which needs a 24 px target per level.
 *  4. **"Modified only".** The answer to "what did I actually change?", which is the
 *     question a diff-and-override UI exists to answer, and the review screen before a
 *     slice.
 *
 * Nothing here is a hover, a tooltip or a drag. The one browser widget used is `<select>`
 * for enums, because the OS wheel is already the touch-native version of that control.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ApiError, PresetRef, SettingValue, UserPreset } from '@orca-web/shared';
import {
  baseValue,
  buildIndex,
  clearAll,
  clearOverride,
  effectiveValue,
  isModified,
  isVisibleAtMode,
  labelOf,
  modifiedCount,
  orderGroups,
  searchOptions,
  setOverride,
  type ConfigSchema,
  type SettingsState,
  type VisibleMode,
} from '../state/settings.ts';
import type { ResolvedSettings } from '@orca-web/shared';
import { Button, ErrorNotice, Row, SearchField, Sheet, Spinner } from './primitives.tsx';
import { SettingField } from './SettingField.tsx';

const MODES: ReadonlyArray<{ value: VisibleMode; label: string }> = [
  { value: 'simple', label: 'Simple' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'expert', label: 'Expert' },
];

export interface SettingsScreenProps {
  schema: ConfigSchema | null;
  resolved: ResolvedSettings | null;
  loading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  state: SettingsState;
  onChange: (next: SettingsState) => void;
  onClose: () => void;
  /** Saved user presets, and the three catalog presets a new one is captured against. */
  userPresets: UserPreset[];
  presetContext: { machine?: PresetRef; process?: PresetRef; filament?: PresetRef } | null;
  onSavePreset: (name: string) => Promise<void>;
  onDeletePreset: (id: string) => Promise<void>;
  presetError: ApiError | null;
}

type View = { kind: 'root' } | { kind: 'group'; name: string } | { kind: 'presets' };

export function SettingsScreen(props: SettingsScreenProps) {
  const { schema, resolved, state, onChange } = props;
  const [mode, setMode] = useState<VisibleMode>('simple');
  const [query, setQuery] = useState('');
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [view, setView] = useState<View>({ kind: 'root' });

  const index = useMemo(
    () => (schema === null ? [] : buildIndex(schema, resolved?.sources ?? {})),
    [schema, resolved],
  );

  /** Groups with a count of what is visible at the current disclosure level. */
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of index) {
      if (!isVisibleAtMode(entry.option, mode)) continue;
      counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
    }
    return orderGroups([...counts.keys()], schema?.categories ?? []).map((name) => ({
      name,
      count: counts.get(name) ?? 0,
    }));
  }, [index, mode, schema]);

  const changed = modifiedCount(state);

  /** What the current view lists, after search, level and the modified-only filter. */
  const rows = useMemo(() => {
    if (schema === null) return [];
    let entries =
      query.trim() !== ''
        ? searchOptions(index, query, mode)
        : view.kind === 'group'
          ? index.filter(
              (entry) => entry.group === view.name && isVisibleAtMode(entry.option, mode),
            )
          : [];
    if (modifiedOnly) {
      // Deliberately ignores the disclosure level: a value you changed must never be
      // invisible because you later moved the level back to Simple. Losing track of an
      // override is how a diff-and-override UI lies.
      entries = (query.trim() === '' && view.kind === 'root' ? index : entries).filter((entry) =>
        isModified(state, entry.option.key),
      );
    }
    return entries;
  }, [index, mode, modifiedOnly, query, schema, state, view]);

  /** How many more this search would find if the disclosure level were raised. */
  const hiddenByLevel = useMemo(() => {
    if (query.trim() === '' || mode === 'expert' || modifiedOnly) return 0;
    return searchOptions(index, query, 'expert').length - rows.length;
  }, [index, mode, modifiedOnly, query, rows.length]);

  const update = useCallback(
    (key: string, value: SettingValue): void => {
      if (schema === null) return;
      const option = schema.options[key];
      if (!option) return;
      onChange(setOverride(state, key, value, baseValue(key, option, resolved).value));
    },
    [onChange, resolved, schema, state],
  );

  const title =
    view.kind === 'group' ? view.name : view.kind === 'presets' ? 'Saved settings' : 'Settings';

  const showingList = query.trim() !== '' || view.kind === 'group' || modifiedOnly;

  return (
    <Sheet
      title={title}
      subtitle={schema === null ? null : `${changed} changed · OrcaSlicer ${schema.orcaVersion}`}
      onClose={props.onClose}
      onBack={
        view.kind === 'root'
          ? undefined
          : () => {
              setView({ kind: 'root' });
              setQuery('');
            }
      }
      testId="settings-sheet"
      toolbar={
        view.kind === 'presets' ? null : (
          <div className="space-y-2">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Search settings"
              testId="settings-search"
            />
            {/*
              A segmented control rather than a scrolling chip strip: three fixed choices
              fit a 390 px column exactly, and a strip that scrolls hides the option on the
              right behind a gesture nobody knows is there.
            */}
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Disclosure level">
              {MODES.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  aria-pressed={mode === entry.value}
                  data-testid={`mode-${entry.value}`}
                  onClick={() => setMode(entry.value)}
                  className={`tap min-h-[2.75rem] rounded-lg border px-2 py-2 text-sm transition-colors ${
                    mode === entry.value
                      ? 'border-accent bg-accent text-accent-ink font-semibold'
                      : 'border-line bg-surface text-muted active:bg-surface-2'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={modifiedOnly}
              disabled={changed === 0}
              data-testid="modified-only"
              onClick={() => setModifiedOnly((current) => !current)}
              className={`tap w-full rounded-lg border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
                modifiedOnly
                  ? 'border-accent bg-accent text-accent-ink font-semibold'
                  : 'border-line bg-surface text-muted active:bg-surface-2'
              }`}
            >
              {changed === 0
                ? 'Nothing changed from the preset yet'
                : `Show only what I changed (${changed})`}
            </button>
          </div>
        )
      }
    >
      {props.error ? <ErrorNotice error={props.error} onRetry={props.onRetry} /> : null}
      {props.loading ? <Spinner label="Loading the settings schema…" /> : null}

      {schema === null || props.loading ? null : view.kind === 'presets' ? (
        <PresetsView {...props} onBack={() => setView({ kind: 'root' })} />
      ) : (
        <div className="space-y-3">
          {!showingList ? (
            <>
              <Row
                label="Saved settings"
                value={
                  props.userPresets.length === 0
                    ? 'None saved yet'
                    : `${props.userPresets.length} saved`
                }
                detail="Named sets of changes, kept on this server"
                onClick={() => setView({ kind: 'presets' })}
                testId="row-saved-settings"
              />
              {groups.map((group) => (
                <Row
                  key={group.name}
                  label={group.name}
                  value={`${group.count} setting${group.count === 1 ? '' : 's'}`}
                  detail={modifiedIn(state, index, group.name)}
                  onClick={() => setView({ kind: 'group', name: group.name })}
                  testId={`settings-group-${group.name}`}
                />
              ))}
              {resolved === null ? (
                <p className="px-1 text-sm text-muted">
                  The preset values could not be loaded, so nothing can be marked modified yet.
                  Changes still apply.
                </p>
              ) : null}
            </>
          ) : rows.length === 0 ? (
            <div className="px-1 py-6 text-center" data-testid="settings-empty">
              <p className="text-sm text-muted">
                {modifiedOnly
                  ? 'Nothing changed from the preset yet.'
                  : `No setting matches “${query}” at the ${mode} level.`}
              </p>
              {/*
                The dead end this avoids: 516 of the 751 options are `advanced`, so at the
                Simple level most searches find nothing and look broken. Say how many are
                one tap away instead of leaving the user to guess that a level exists.
              */}
              {hiddenByLevel > 0 ? (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    onClick={() => setMode('expert')}
                    testId="settings-raise-level"
                  >
                    Show {hiddenByLevel} more at the expert level
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            rows.map((entry) => {
              const base = baseValue(entry.option.key, entry.option, resolved);
              return (
                <SettingField
                  key={entry.option.key}
                  option={entry.option}
                  base={base}
                  value={effectiveValue(state, entry.option.key, base)}
                  modified={isModified(state, entry.option.key)}
                  onChange={(value) => update(entry.option.key, value)}
                  onRevert={() => onChange(clearOverride(state, entry.option.key))}
                />
              );
            })
          )}

          {changed > 0 ? (
            <Button
              variant="ghost"
              onClick={() => onChange(clearAll())}
              testId="settings-reset-all"
            >
              Revert all {changed} change{changed === 1 ? '' : 's'}
            </Button>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

/** "3 changed" under a group row, so the modified set is findable without the filter. */
function modifiedIn(
  state: SettingsState,
  index: ReturnType<typeof buildIndex>,
  group: string,
): string | null {
  const count = index.filter(
    (entry) => entry.group === group && isModified(state, entry.option.key),
  ).length;
  return count === 0 ? null : `${count} changed`;
}

/**
 * Named user presets.
 *
 * They are sets of *overrides*, not profiles: applying one leaves the catalog preset
 * underneath it exactly as it was, and nothing is ever written into OrcaSlicer's own
 * profile tree (see `apps/api/src/settings/user-preset-store.ts` for why that matters
 * more than it sounds).
 */
function PresetsView({
  userPresets,
  state,
  onChange,
  onSavePreset,
  onDeletePreset,
  presetError,
  presetContext,
  schema,
  onBack,
}: SettingsScreenProps & { onBack: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = modifiedCount(state);

  return (
    <div className="space-y-3">
      {presetError ? <ErrorNotice error={presetError} /> : null}

      <section className="rounded-xl border border-line bg-surface p-3">
        <h3 className="text-sm font-semibold text-text">Save the current changes</h3>
        <p className="mt-1 text-sm text-muted">
          {changed === 0
            ? 'Change a setting first — there is nothing to save yet.'
            : `${changed} change${changed === 1 ? '' : 's'} will be saved as a named set.`}
        </p>
        {/*
          Which presets the diff was taken against. Advisory, not a restriction: a saved
          set can be applied to any printer, and it is only ever a set of overrides — the
          preset underneath it is untouched, and no profile file exists for it anywhere.
        */}
        {presetContext?.process ? (
          <p className="mt-1 text-xs text-muted">
            Measured against {presetContext.process.name}
            {presetContext.filament ? ` + ${presetContext.filament.name}` : ''}
          </p>
        ) : null}
        <div className="mt-2 space-y-2">
          <input
            type="text"
            value={name}
            placeholder="e.g. Fast draft"
            aria-label="Name for these settings"
            data-testid="preset-name"
            onChange={(event) => setName(event.target.value)}
            className="tap min-h-[2.75rem] w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-base text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <Button
            variant="secondary"
            disabled={changed === 0 || name.trim() === '' || busy}
            testId="preset-save"
            onClick={() => {
              setBusy(true);
              void onSavePreset(name.trim()).finally(() => {
                setBusy(false);
                setName('');
              });
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </section>

      {userPresets.length === 0 ? (
        <p className="px-1 py-4 text-center text-sm text-muted">No saved settings yet.</p>
      ) : (
        userPresets.map((preset) => {
          const count = Object.keys(preset.overrides).length;
          return (
            <section
              key={preset.id}
              data-testid={`user-preset-${preset.id}`}
              className="rounded-xl border border-line bg-surface p-3"
            >
              <p className="text-base break-words text-text">{preset.name}</p>
              <p className="mt-0.5 text-sm text-muted">
                {count} setting{count === 1 ? '' : 's'}
                {preset.basedOn?.process ? ` · from ${preset.basedOn.process.name}` : ''}
              </p>
              <ul className="mt-2 space-y-0.5">
                {Object.keys(preset.overrides)
                  .slice(0, 6)
                  .map((key) => (
                    <li key={key} className="font-mono text-xs break-all text-muted">
                      {schema?.options[key] ? labelOf(schema.options[key]) : key}
                    </li>
                  ))}
              </ul>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button
                  variant="secondary"
                  testId={`apply-${preset.id}`}
                  onClick={() => {
                    // Replaces the current set rather than merging: a named set is a
                    // whole answer, and a half-applied one is nobody's intent.
                    onChange({ overrides: { ...preset.overrides } });
                    onBack();
                  }}
                >
                  Apply
                </Button>
                <Button
                  variant="danger"
                  testId={`delete-${preset.id}`}
                  onClick={() => void onDeletePreset(preset.id)}
                >
                  Delete
                </Button>
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
