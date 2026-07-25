/**
 * The touch vocabulary. Every interactive element in the app is one of these, which is
 * how "every target is at least 48px and nothing depends on hover" stays true as the app
 * grows rather than being re-argued per component.
 *
 * Note what is absent: there is no icon-only button, no tooltip, no hover state and no
 * drag affordance. Hard constraint #5 — a thumb cannot hover, and a 24px icon is not a
 * target. The layout puts a toolbar over the 3D view the way the desktop build does, but
 * the *buttons* on that toolbar are {@link ToolButton}s: a 48px icon with its name printed
 * under it, because the desktop original relies on a tooltip and a tooltip needs a pointer.
 */

import type { ApiError } from '@orca-web/shared';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { Icon, type IconName } from './icons.tsx';

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  type = 'button',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  testId?: string;
}) {
  const palette = {
    primary: 'bg-accent text-accent-ink active:bg-sky-300 font-semibold',
    secondary: 'bg-surface-2 text-text border border-line active:bg-line',
    ghost: 'bg-transparent text-muted border border-line active:bg-surface-2',
    danger: 'bg-transparent text-danger border border-danger/50 active:bg-danger/10',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`tap w-full rounded-xl px-4 py-3 text-base transition-colors disabled:opacity-40 ${palette}`}
    >
      {children}
    </button>
  );
}

/**
 * A full-width tappable row: the app's main navigational unit, because a 390px column
 * has room for exactly one column of them and a thumb reaches all of it.
 */
export function Row({
  label,
  value,
  detail,
  onClick,
  disabled = false,
  selected = false,
  testId,
}: {
  label: string;
  value?: string | null;
  detail?: string | null;
  onClick?: () => void;
  disabled?: boolean;
  selected?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-current={selected ? 'true' : undefined}
      className={`tap flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-40 ${
        selected ? 'border-accent bg-accent/10' : 'border-line bg-surface active:bg-surface-2'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs tracking-wide text-muted uppercase">{label}</span>
        <span className="block truncate text-base text-text">{value ?? '—'}</span>
        {detail !== undefined && detail !== null && detail !== '' ? (
          <span className="block truncate text-sm text-muted">{detail}</span>
        ) : null}
      </span>
      <span aria-hidden className="shrink-0 text-muted">
        {selected ? '✓' : '›'}
      </span>
    </button>
  );
}

/** A choice inside a picker: name on top, whatever distinguishes it underneath. */
export function OptionRow({
  name,
  detail,
  selected,
  onClick,
  testId,
}: {
  name: string;
  detail?: string | null;
  selected?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={selected ? 'true' : 'false'}
      className={`tap flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        selected ? 'border-accent bg-accent/10' : 'border-line bg-surface active:bg-surface-2'
      }`}
    >
      <span className="min-w-0 flex-1">
        {/* Preset names are long ("Bambu PLA Basic @BBL H2S") and the viewport is 390px;
            wrapping beats truncating here because the tail is what distinguishes them. */}
        <span className="block text-base leading-snug break-words text-text">{name}</span>
        {detail ? <span className="mt-0.5 block text-sm text-muted">{detail}</span> : null}
      </span>
      {selected ? (
        <span aria-hidden className="shrink-0 text-accent">
          ✓
        </span>
      ) : null}
    </button>
  );
}

/** Material / category filter. Chips scroll horizontally inside their own container. */
export function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`tap shrink-0 rounded-full border px-4 py-2 text-sm whitespace-nowrap transition-colors ${
        selected
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-line bg-surface text-muted active:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * A full-screen picker.
 *
 * Full-screen rather than a partial sheet on purpose: a 390×844 viewport has no room for
 * a list *and* the page behind it, and a half-height sheet puts the list under the
 * thumb's own hand. The close control is a full-width row at the top, not a 24px ✕.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  onBack,
  children,
  toolbar,
  testId,
}: {
  title: string;
  subtitle?: string | null;
  onClose: () => void;
  onBack?: (() => void) | undefined;
  children: ReactNode;
  toolbar?: ReactNode;
  testId?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      /*
       * Full-screen on a phone, a centred card from 640px up. The card is the only
       * concession the layout makes to a mouse: 384 printers in a 1600px-wide column
       * would be one word per line, and the workspace behind it stays visible, which is
       * the whole point of putting the 3D view first.
       */
      className="sheet-in fixed inset-0 z-50 flex flex-col bg-ink sm:inset-y-6 sm:left-1/2 sm:w-[34rem] sm:-translate-x-1/2 sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="tap rounded-lg px-3 text-base text-accent active:bg-surface-2"
          >
            ‹ Back
          </button>
        ) : null}
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate px-1 text-base font-semibold outline-none"
        >
          {title}
          {subtitle ? <span className="block truncate text-xs text-muted">{subtitle}</span> : null}
        </h2>
        <button
          type="button"
          onClick={onClose}
          data-testid="sheet-close"
          className="tap rounded-lg px-3 text-base text-accent active:bg-surface-2"
        >
          Close
        </button>
      </header>
      {toolbar ? (
        <div className="shrink-0 border-b border-line bg-ink px-3 py-2">{toolbar}</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="search"
        inputMode="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        className="tap w-full min-w-0 rounded-xl border border-line bg-surface px-4 py-2 text-base text-text placeholder:text-muted focus:border-accent focus:outline-none"
      />
      {value === '' ? null : (
        <button
          type="button"
          onClick={() => onChange('')}
          className="tap shrink-0 rounded-xl border border-line px-3 text-sm text-muted active:bg-surface-2"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * A server failure, shown the way the API meant it to be shown: `message` verbatim,
 * `hint` underneath (it is written to be user-facing — the 404 for an unknown nozzle
 * puts the real nozzle list in there), and "Try again" only when `retryable`.
 */
export function ErrorNotice({
  error,
  onRetry,
  testId,
}: {
  error: ApiError;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId ?? 'error-notice'}
      className="rounded-xl border border-danger/40 bg-danger/10 p-4"
    >
      <p className="text-base font-semibold text-danger">{error.message}</p>
      {error.hint ? <p className="mt-1 text-sm text-muted">{error.hint}</p> : null}
      {error.retryable && onRetry ? (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry} testId="error-retry">
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Warnings from the engine. The spec calls them "the user's only signal for things like
 * unsupported overhangs", so they are shown while slicing *and* kept in the results —
 * never a toast that disappears.
 */
export function WarningList({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div
      data-testid="warnings"
      className="rounded-xl border border-warn/40 bg-warn/10 p-4"
      role="status"
    >
      <p className="text-sm font-semibold text-warn">
        {warnings.length === 1 ? 'Slicer warning' : `${warnings.length} slicer warnings`}
      </p>
      <ul className="mt-2 space-y-1">
        {warnings.map((warning) => (
          <li key={warning} className="text-sm break-words text-text">
            {warning}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="pulse-soft py-6 text-center text-sm text-muted" role="status">
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The floating layer: what sits *on* the 3D view rather than in a column under it.
// ---------------------------------------------------------------------------

/**
 * A button on a floating toolbar: icon above, name below, 48px minimum in both axes.
 *
 * The caption is not decoration. OrcaSlicer's desktop toolbar is icon-only and explains
 * itself with tooltips; the same toolbar on a phone would be nine unlabelled squares. At
 * 9px the caption costs 11px of height and removes the guesswork, which is the trade the
 * rest of this app already makes everywhere else.
 */
export function ToolButton({
  icon,
  label,
  caption,
  onClick,
  selected = false,
  disabled = false,
  danger = false,
  testId,
}: {
  icon: IconName;
  /** The accessible name, and the caption unless `caption` overrides it. */
  label: string;
  /** A shorter caption when the full name will not fit — "+1" for "one layer up". */
  caption?: string;
  onClick: () => void;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  const palette = selected
    ? 'border-accent bg-accent text-accent-ink'
    : danger
      ? 'border-transparent text-danger active:bg-danger/15'
      : 'border-transparent text-text active:bg-surface-2';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={label}
      data-testid={testId}
      className={`tap flex w-rail flex-col items-center justify-center gap-0.5 rounded-xl border px-1 py-1.5 transition-colors disabled:opacity-35 ${palette}`}
    >
      <Icon name={icon} size={21} />
      <span className="text-[0.5625rem] leading-none font-medium tracking-wide">
        {caption ?? label}
      </span>
    </button>
  );
}

/** The container a group of {@link ToolButton}s floats in. */
export function ToolGroup({
  children,
  label,
  orientation = 'vertical',
}: {
  children: ReactNode;
  label: string;
  orientation?: 'vertical' | 'horizontal';
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      className={`glass flex gap-1 rounded-2xl p-1 ${orientation === 'vertical' ? 'flex-col' : 'flex-row'}`}
    >
      {children}
    </div>
  );
}

/**
 * A titled block inside the dock.
 *
 * The dock is one scrolling column on every screen size — a phone sheet and a desktop
 * side panel are the same list at different heights — so the section header is what tells
 * you where you are after a scroll.
 */
export function Panel({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="text-[0.6875rem] font-semibold tracking-[0.08em] text-muted uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A segmented control: two or three mutually exclusive choices, all visible at once.
 *
 * Used for the workspace tabs and the transform mode. A `<select>` would be smaller, but
 * these are the app's primary navigation and a picker that hides the alternatives behind
 * a tap is the wrong shape for something switched this often.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  testIdPrefix,
  compact = false,
}: {
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  testIdPrefix: string;
  compact?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`flex gap-1 rounded-xl border border-line bg-surface-2/70 p-1 ${
        compact ? '' : 'w-full'
      }`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          disabled={option.disabled ?? false}
          data-testid={`${testIdPrefix}-${option.value}`}
          onClick={() => onChange(option.value)}
          className={`tap flex-1 rounded-lg px-3 text-sm transition-colors disabled:opacity-35 ${
            value === option.value
              ? 'bg-accent text-accent-ink font-semibold'
              : 'text-muted active:bg-line'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
