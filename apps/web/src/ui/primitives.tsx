/**
 * The touch vocabulary. Every interactive element in the app is one of these, which is
 * how "every target is at least 48px and nothing depends on hover" stays true as the app
 * grows rather than being re-argued per component.
 *
 * Note what is absent: there is no icon-only button, no tooltip, no hover state and no
 * drag affordance. Hard constraint #5 — a thumb cannot hover, and a 24px icon is not a
 * target.
 */

import type { ApiError } from '@orca-web/shared';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

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
      className="sheet-in fixed inset-0 z-50 flex flex-col bg-ink"
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
