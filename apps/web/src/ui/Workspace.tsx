/**
 * The shell: one 3D viewport, everything else floating on top of it.
 *
 * This is the shape OrcaSlicer's desktop build and SimplyPrint's web slicer both have —
 * the model is the screen, and the controls are panels over it — and the reason to adopt
 * it here is not resemblance. The old layout gave the canvas a fixed 38 vh and stacked
 * the controls underneath in a scrolling column, which meant the thing being manipulated
 * and the control manipulating it were never both comfortably in view, and two thirds of
 * a phone screen showed buttons.
 *
 * What makes it work on a 390 px phone rather than being a desktop layout shrunk:
 *
 *  - **The dock is one column at every size.** On a wide screen it is a card floating at
 *    the right; below 60 rem it is the same column as a bottom sheet with three heights.
 *    There is no second, mobile-only information architecture to keep in step.
 *  - **The sheet has detents, not a scroll-to-reveal.** Peek shows the action bar, half is
 *    the working position, full is for the long lists. It is dragged by a 48 px handle,
 *    and a tap on the handle cycles — a drag is an affordance a thumb finds, a tap is the
 *    one it can always fall back on.
 *  - **Nothing overlaps silently.** The rectangle of canvas that no panel is covering is
 *    published as `--free-*` custom properties *and* through {@link useViewportInsets},
 *    so overlays position against it and the scene shifts its projection into it. Without
 *    that, on a phone the plate would centre itself behind the sheet.
 *  - **Gaps stay draggable.** Every positioning wrapper is `pointer-events-none` and only
 *    the panels themselves take input, so the canvas keeps the whole viewport for orbiting
 *    except where a control actually is.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

/** Below this the dock becomes a bottom sheet. 60rem ~= a small tablet in landscape. */
const WIDE_QUERY = '(min-width: 60rem)';

/** Heights of the bottom sheet, as a fraction of the viewport. */
const DETENTS = { peek: 0.26, half: 0.52, full: 0.88 } as const;
export type Detent = keyof typeof DETENTS;
const ORDER: readonly Detent[] = ['peek', 'half', 'full'];

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

const InsetsContext = createContext<Insets>(ZERO);

/**
 * The part of the canvas no panel is covering, in CSS pixels.
 *
 * A stage reads this to decide where "centre" is: `PlaterStage` turns it into a
 * projection offset so the plate sits in the visible rectangle rather than in the middle
 * of the canvas, half of which may be under the dock.
 */
export function useViewportInsets(): Insets {
  return useContext(InsetsContext);
}

interface DockHandle {
  wide: boolean;
  detent: Detent;
  setDetent: (detent: Detent) => void;
  /** Raise the sheet to at least `half`, for a control that just became relevant. */
  reveal: () => void;
  /**
   * Raise the sheet *and* scroll the named panel to the top of it.
   *
   * What makes the floating rail work on a phone: tapping Rotate has to put the rotation
   * fields in front of you, and they are one section down a scrolling column.
   */
  revealPanel: (testId: string) => void;
}

const DockContext = createContext<DockHandle>({
  wide: true,
  detent: 'half',
  setDetent: () => undefined,
  reveal: () => undefined,
  revealPanel: () => undefined,
});

export function useDock(): DockHandle {
  return useContext(DockContext);
}

/** `matchMedia` is absent in some test environments and in very old WebViews. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * The parts of the workspace that do not belong to either view.
 *
 * `App` owns the selection, the job and the sheets, so it builds these once and both the
 * Prepare and the Preview view render them in the same places. Passing nodes rather than
 * data keeps the views from having to know what a printer or a job is.
 */
export interface Chrome {
  title: ReactNode;
  tabs: ReactNode;
  status?: ReactNode;
  /** Progress and results. Above everything else in the dock while it exists. */
  jobPanel?: ReactNode;
  /** Model, printer, nozzle, quality, filament, settings. */
  printPanel?: ReactNode;
  /** The dock's pinned action bar. */
  action?: ReactNode;
  revealSignal?: string | number | null | undefined;
}

export interface WorkspaceProps {
  /** The full-bleed canvas layer. Everything else floats over it. */
  stage: ReactNode;
  /** Top-left of the bar: what is being worked on. */
  title: ReactNode;
  /** Centre of the bar: the Prepare / Preview switch. */
  tabs?: ReactNode;
  /** Right of the bar. Hidden below 60rem, where the dock says the same thing. */
  status?: ReactNode;
  /** The vertical tool rail, top-left over the canvas. */
  rail?: ReactNode;
  /** Camera controls, bottom-left over the canvas. */
  viewControls?: ReactNode;
  /** Anything else over the canvas; positioned against the `--free-*` properties. */
  overlay?: ReactNode;
  /** The scrolling column: a card on the right, or a bottom sheet. */
  dock: ReactNode;
  /** Pinned under the dock's scroll area, so the primary action is never scrolled away. */
  dockAction?: ReactNode;
  /**
   * Changing this to a new defined value raises the sheet. Used when a slice starts, so
   * progress does not arrive underneath the fold on a phone.
   */
  revealSignal?: string | number | null | undefined;
  testId?: string | undefined;
}

export function Workspace({
  stage,
  title,
  tabs,
  status,
  rail,
  viewControls,
  overlay,
  dock,
  dockAction,
  revealSignal,
  testId,
}: WorkspaceProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [detent, setDetent] = useState<Detent>('half');
  /** Non-null only while a finger is on the handle. */
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [insets, setInsets] = useState<Insets>(ZERO);

  const barRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const reveal = useCallback(() => {
    setDetent((current) => (current === 'peek' ? 'half' : current));
  }, []);

  const revealPanel = useCallback(
    (testId: string) => {
      reveal();
      // After the height transition, or the scroll lands in the old geometry.
      window.setTimeout(() => {
        const container = scrollRef.current;
        const panel = container?.querySelector(`[data-testid="${testId}"]`);
        if (!container || !panel) return;
        const delta = panel.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollBy({ top: delta, behavior: 'smooth' });
      }, 220);
    },
    [reveal],
  );

  // A new job, a newly selected object: raise the sheet so its panel is on screen.
  const lastSignal = useRef(revealSignal);
  useEffect(() => {
    if (revealSignal === lastSignal.current) return;
    lastSignal.current = revealSignal;
    if (revealSignal !== null && revealSignal !== undefined) reveal();
  }, [revealSignal, reveal]);

  /**
   * The free rectangle, measured rather than assumed.
   *
   * The bar and the dock size themselves from their content — a two-line title, a
   * warning in the dock's action bar — so a table of constants here would be wrong the
   * first time anything grew. `ResizeObserver` on the three panels covers every case
   * including the sheet being dragged.
   */
  useLayoutEffect(() => {
    const measure = (): void => {
      const bar = barRef.current?.getBoundingClientRect();
      const dockBox = dockRef.current?.getBoundingClientRect();
      const railBox = railRef.current?.getBoundingClientRect();
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      const next: Insets = {
        top: bar ? Math.round(bar.bottom + 8) : 0,
        right: wide && dockBox ? Math.round(width - dockBox.left + 8) : 0,
        bottom: !wide && dockBox ? Math.round(height - dockBox.top + 8) : 0,
        left: railBox ? Math.round(railBox.right + 8) : 0,
      };
      setInsets((current) =>
        current.top === next.top &&
        current.right === next.right &&
        current.bottom === next.bottom &&
        current.left === next.left
          ? current
          : next,
      );
    };
    measure();
    // `ResizeObserver` is absent in jsdom, where there is no layout to observe anyway;
    // the window listener and the per-change re-run below cover the rest.
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
    for (const element of [barRef.current, dockRef.current, railRef.current]) {
      if (element) observer?.observe(element);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [wide, detent, dragHeight, rail]);

  // -- the sheet gesture ----------------------------------------------------

  const gesture = useRef<{ startY: number; startHeight: number; moved: number } | null>(null);

  const viewportHeight = (): number => (typeof window === 'undefined' ? 800 : window.innerHeight);

  const onHandleDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (wide) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = {
      startY: event.clientY,
      startHeight: dockRef.current?.getBoundingClientRect().height ?? 0,
      moved: 0,
    };
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = gesture.current;
    if (!active) return;
    const delta = active.startY - event.clientY;
    active.moved = Math.max(active.moved, Math.abs(delta));
    const height = viewportHeight();
    setDragHeight(
      Math.min(height * DETENTS.full, Math.max(height * 0.14, active.startHeight + delta)),
    );
  };

  const onHandleUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const active = gesture.current;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!active) return;
    // A press that did not travel is a tap, and a tap cycles: the drag is discoverable
    // only once you have tried it, and something has to work the first time.
    if (active.moved < 8) {
      setDragHeight(null);
      setDetent((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] as Detent);
      return;
    }
    const fraction = (dragHeight ?? active.startHeight) / viewportHeight();
    const nearest = ORDER.reduce((best, candidate) =>
      Math.abs(DETENTS[candidate] - fraction) < Math.abs(DETENTS[best] - fraction)
        ? candidate
        : best,
    );
    setDragHeight(null);
    setDetent(nearest);
  };

  const dockHandle = useMemo<DockHandle>(
    () => ({ wide, detent, setDetent, reveal, revealPanel }),
    [wide, detent, reveal, revealPanel],
  );

  const style = {
    '--free-top': `${insets.top}px`,
    '--free-right': `${insets.right}px`,
    '--free-bottom': `${insets.bottom}px`,
    '--free-left': `${insets.left}px`,
  } as CSSProperties;

  const sheetHeight =
    dragHeight !== null ? `${Math.round(dragHeight)}px` : `${Math.round(DETENTS[detent] * 100)}dvh`;

  return (
    <DockContext.Provider value={dockHandle}>
      <InsetsContext.Provider value={insets}>
        <div
          data-testid={testId}
          data-detent={wide ? 'wide' : detent}
          style={style}
          className="fixed inset-0 overflow-hidden bg-ink"
        >
          {/* The canvas. Full-bleed on purpose: the panels are over the picture, not
              beside it, and the projection offset keeps the model out from under them. */}
          <div className="absolute inset-0 z-0">{stage}</div>

          {/* -- the bar ---------------------------------------------------- */}
          <div
            ref={barRef}
            className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
          >
            <div className="glass pointer-events-auto flex min-w-0 flex-1 items-center gap-2 rounded-2xl px-2 py-1.5">
              <div className="min-w-0 flex-1">{title}</div>
              {tabs ? <div className="shrink-0">{tabs}</div> : null}
              {status ? <div className="hidden shrink-0 lg:block">{status}</div> : null}
            </div>
          </div>

          {/* -- the tool rail ---------------------------------------------- */}
          {rail ? (
            <div
              ref={railRef}
              className="no-scrollbar pointer-events-none absolute left-2 z-20 flex max-h-[calc(100dvh-var(--free-top)-var(--free-bottom)-5rem)] flex-col overflow-y-auto"
              style={{ top: insets.top }}
            >
              <div className="pointer-events-auto">{rail}</div>
            </div>
          ) : null}

          {/* -- camera controls -------------------------------------------- */}
          {viewControls ? (
            <div
              className="pointer-events-none absolute left-2 z-20"
              style={{ bottom: insets.bottom + 8 }}
            >
              <div className="pointer-events-auto">{viewControls}</div>
            </div>
          ) : null}

          {overlay}

          {/* -- the dock ---------------------------------------------------- */}
          <aside
            ref={dockRef}
            data-testid="dock"
            aria-label="Controls"
            className={
              wide
                ? 'glass absolute right-3 z-30 flex w-[23rem] flex-col overflow-hidden rounded-2xl'
                : 'glass absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-2xl border-x-0 border-b-0'
            }
            style={
              wide
                ? { top: insets.top, bottom: 12 }
                : {
                    height: sheetHeight,
                    transition: dragHeight === null ? 'height 0.2s ease' : undefined,
                  }
            }
          >
            {wide ? null : (
              <button
                type="button"
                onPointerDown={onHandleDown}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                data-testid="dock-handle"
                aria-label={`Panel height: ${detent}. Drag or tap to resize.`}
                className="tap flex w-full shrink-0 touch-none items-center justify-center py-2 active:bg-surface-2"
              >
                <span aria-hidden className="block h-1.5 w-12 rounded-full bg-line" />
              </button>
            )}
            <div
              ref={scrollRef}
              data-testid="dock-scroll"
              className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pt-1 pb-3"
            >
              {dock}
            </div>
            {dockAction ? (
              <div className="shrink-0 border-t border-line/70 bg-ink/60 px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
                {dockAction}
              </div>
            ) : null}
          </aside>
        </div>
      </InsetsContext.Provider>
    </DockContext.Provider>
  );
}

/**
 * The top bar's left-hand block: what is being worked on, and one line about it.
 *
 * Two lines at 13/11 px rather than the old `<h1>`: the bar is 56 px of a 844 px screen
 * and it is over the picture, so it says the model's name and the plate it is on and
 * stops there.
 */
export function TitleBlock({
  name,
  detail,
  detailTestId,
}: {
  name: string;
  detail?: string | null;
  detailTestId?: string;
}) {
  return (
    <div className="min-w-0 px-1">
      <p className="truncate text-sm leading-tight font-semibold">{name}</p>
      {detail ? (
        <p
          className="truncate text-[0.6875rem] leading-tight text-muted"
          data-testid={detailTestId}
        >
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A pill that floats over the canvas: the plate's problems, the slice's progress.
 *
 * Positioned by the caller against the free rectangle; this only carries the look and the
 * politeness attributes.
 */
export function FloatingNotice({
  tone = 'neutral',
  children,
  testId,
  role = 'status',
}: {
  tone?: 'neutral' | 'danger' | 'warn';
  children: ReactNode;
  testId?: string;
  role?: 'status' | 'alert';
}) {
  const palette = {
    neutral: 'text-text',
    danger: 'border-danger/60 text-danger',
    warn: 'border-warn/60 text-warn',
  }[tone];
  return (
    <div
      role={role}
      data-testid={testId}
      className={`glass pointer-events-auto max-w-full rounded-xl px-3 py-2 text-xs leading-snug ${palette}`}
    >
      {children}
    </div>
  );
}
