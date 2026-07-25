/**
 * One setting, as a row.
 *
 * The widget comes from `valueKind`; `isArray` makes it a per-extruder list rather than a
 * scalar; `units` is the suffix; `enumChoices` renders `label` and submits `value`, in
 * upstream's order.
 *
 * Two deliberate choices about the phone:
 *
 *  - **`<select>` is native.** A custom dropdown would need a popover, a scroll trap and
 *    a dismiss gesture; the OS wheel is already all of those and is the control a thumb
 *    expects. It is the one place this app uses a browser widget rather than one of
 *    `primitives.tsx`'s buttons.
 *  - **`inputMode` rather than `type="number"`.** A numeric input on iOS brings up the
 *    right keypad either way, but `type="number"` also adds spinners nobody can hit at
 *    390 px and silently discards a value the browser considers malformed mid-typing.
 *
 * The "modified" state is a full-width strip, not a colour: colour alone would be the
 * only signal, and it would be the only signal on a screen someone is using in daylight.
 */

import { useId } from 'react';
import type { SettingValue } from '@orca-web/shared';
import { asList, labelOf, type BaseValue, type OptionSchema } from '../state/settings.ts';

/** What the row says about where the current number came from. */
function originText(base: BaseValue): string {
  if (base.origin === 'preset') {
    return base.source === null ? 'from the preset' : `from the ${base.source} preset`;
  }
  // The honest wording for SPEC deviation #1: no preset in the chain mentions this key,
  // so the slicer would fall back to its compiled-in value. That is worth saying out
  // loud, because it is exactly the case where "unmodified" does not mean "as chosen".
  return 'not set by any preset — slicer built-in';
}

function Suffix({ units }: { units: string | undefined }) {
  if (units === undefined || units === '') return null;
  return (
    <span aria-hidden className="shrink-0 pl-2 text-sm text-muted">
      {units}
    </span>
  );
}

const INPUT_CLASS =
  'tap min-h-[2.75rem] w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2 text-base text-text focus:border-accent focus:outline-none';

function TextControl({
  option,
  value,
  onChange,
  id,
  testId,
}: {
  option: OptionSchema;
  value: string;
  onChange: (next: string) => void;
  id: string;
  testId: string;
}) {
  const numeric = option.valueKind === 'int' || option.valueKind === 'float';
  if (option.multiline === true) {
    return (
      <textarea
        id={id}
        data-testid={testId}
        rows={4}
        value={value}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        className={`${INPUT_CLASS} font-mono text-sm`}
      />
    );
  }
  return (
    <input
      id={id}
      data-testid={testId}
      type="text"
      inputMode={numeric ? 'decimal' : 'text'}
      value={value}
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      onChange={(event) => onChange(event.target.value)}
      className={INPUT_CLASS}
    />
  );
}

function BoolControl({
  value,
  onChange,
  testId,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  testId: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        { label: 'Off', on: false },
        { label: 'On', on: true },
      ].map((choice) => (
        <button
          key={choice.label}
          type="button"
          aria-pressed={value === choice.on}
          data-testid={`${testId}-${choice.on ? 'on' : 'off'}`}
          onClick={() => onChange(choice.on)}
          className={`tap min-h-[2.75rem] rounded-lg border px-3 py-2 text-base transition-colors ${
            value === choice.on
              ? 'border-accent bg-accent text-accent-ink font-semibold'
              : 'border-line bg-surface-2 text-muted active:bg-line'
          }`}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A scalar's control is `field-<key>`; a vector's are `field-<key>-0`, `-1`, … Keeping
 * the scalar name unsuffixed is what makes the common case readable in a test and in a
 * Playwright selector, which is where these ids are actually used.
 */
function controlTestId(key: string, index: number): string {
  return index === 0 ? `field-${key}` : `field-${key}-${index}`;
}

function toBool(value: string | number | boolean | undefined): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toText(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * Turn what the widgets produced back into the schema's shape.
 *
 * The *types* matter downstream: the engine picks a vector separator from the element
 * type, and a numeric vector sent as strings would still be joined correctly but a
 * genuinely-string vector sent as numbers would not (SPEC deviation #25). So a numeric
 * option becomes a number here, at the point the schema is in hand.
 */
export function toSettingValue(
  option: OptionSchema,
  parts: ReadonlyArray<string | boolean>,
): SettingValue {
  const scalars = parts.map((part) => {
    if (option.valueKind === 'bool') return typeof part === 'boolean' ? part : toBool(part);
    const text = String(part);
    if (option.valueKind === 'int' || option.valueKind === 'float') {
      const parsed = Number(text);
      // A half-typed "0." or "-" is not a number yet; keep the text so the field does not
      // jump under the user's finger, and let the caller's validation reject it.
      return Number.isFinite(parsed) && text.trim() !== '' ? parsed : text;
    }
    return text;
  });
  return option.isArray ? scalars : ((scalars[0] ?? '') as SettingValue);
}

export function SettingField({
  option,
  base,
  value,
  modified,
  onChange,
  onRevert,
}: {
  option: OptionSchema;
  base: BaseValue;
  value: SettingValue;
  modified: boolean;
  onChange: (next: SettingValue) => void;
  onRevert: () => void;
}) {
  const id = useId();
  const unset = value === null;
  const parts = asList(value);
  // A vector's length follows the preset's, so a two-extruder machine gets two fields and
  // a one-extruder machine gets one — never a guessed count.
  const arity = option.isArray ? Math.max(1, asList(base.value).length, parts.length) : 1;

  const update = (index: number, next: string | boolean): void => {
    const draft: Array<string | boolean> = [];
    for (let i = 0; i < arity; i += 1) {
      draft.push(
        i === index
          ? next
          : option.valueKind === 'bool'
            ? toBool(parts[i])
            : toText(parts[i] ?? asList(base.value)[i]),
      );
    }
    onChange(toSettingValue(option, draft));
  };

  return (
    <section
      data-testid={`setting-${option.key}`}
      data-modified={modified ? 'true' : 'false'}
      className={`rounded-xl border px-3 py-3 ${
        modified ? 'border-accent bg-accent/10' : 'border-line bg-surface'
      }`}
    >
      <div className="flex items-start gap-2">
        <label htmlFor={`${id}-0`} className="min-w-0 flex-1 text-base leading-snug text-text">
          {labelOf(option)}
        </label>
        {modified ? (
          <span
            data-testid={`modified-${option.key}`}
            className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-ink"
          >
            Modified
          </span>
        ) : null}
      </div>

      <p className="mt-0.5 font-mono text-xs break-all text-muted">{option.key}</p>

      <div className="mt-2 space-y-2">
        {unset ? (
          <p className="text-sm text-muted">Unset — the printer's own value is used.</p>
        ) : (
          Array.from({ length: arity }, (_, index) => (
            <div key={index} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                {arity > 1 ? (
                  <span className="mb-1 block text-xs text-muted">Extruder {index + 1}</span>
                ) : null}
                {option.valueKind === 'bool' ? (
                  <BoolControl
                    value={toBool(parts[index])}
                    onChange={(next) => update(index, next)}
                    testId={controlTestId(option.key, index)}
                  />
                ) : option.valueKind === 'enum' ? (
                  <select
                    id={`${id}-${index}`}
                    data-testid={controlTestId(option.key, index)}
                    value={toText(parts[index])}
                    onChange={(event) => update(index, event.target.value)}
                    className={INPUT_CLASS}
                  >
                    {/* Upstream's order, upstream's labels, upstream's values. */}
                    {(option.enumChoices ?? []).map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <TextControl
                    id={`${id}-${index}`}
                    testId={controlTestId(option.key, index)}
                    option={option}
                    value={toText(parts[index])}
                    onChange={(next) => update(index, next)}
                  />
                )}
              </div>
              <Suffix units={option.units} />
            </div>
          ))
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-muted">{originText(base)}</span>
        {option.nullable ? (
          <button
            type="button"
            data-testid={`unset-${option.key}`}
            onClick={() => onChange(unset ? (asList(base.value)[0] ?? '') : null)}
            className="tap rounded-lg px-2 py-1 text-sm text-accent active:bg-surface-2"
          >
            {unset ? 'Set a value' : 'Unset'}
          </button>
        ) : null}
        {modified ? (
          <button
            type="button"
            data-testid={`revert-${option.key}`}
            onClick={onRevert}
            className="tap ml-auto rounded-lg px-2 py-1 text-sm text-accent active:bg-surface-2"
          >
            Revert
          </button>
        ) : null}
      </div>

      {option.tooltip ? (
        <p className="mt-2 border-t border-line pt-2 text-sm leading-snug text-muted">
          {option.tooltip}
        </p>
      ) : null}
    </section>
  );
}
