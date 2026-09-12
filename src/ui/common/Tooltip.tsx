import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { PrimitiveTooltipContent } from '../../canvas/presets';

/** Hover must clear this before the tooltip appears — long enough that a pointer merely
 *  travelling across the toolbar never triggers it. */
const SHOW_DELAY_MS = 400;
/** Grace period after the pointer leaves before the tooltip actually closes, so a brief flicker
 *  off the trigger (e.g. crossing its own border) doesn't retrigger the show delay. */
const HIDE_DELAY_MS = 150;
/** Once one tooltip in a group is up, its neighbours are effectively already "asked for" — waiting
 *  the full delay again at every stop makes a dense bar feel unresponsive. Not zero: a diagonal
 *  traverse clips the corners of buttons it isn't aiming at, and instant would strobe. */
const WARM_SHOW_DELAY_MS = 80;
/** How long a group stays warm after its last tooltip closes. */
const WARM_WINDOW_MS = 300;
/** Clears the toolbar's bottom border plus a small margin. */
const GAP = 8;
/** Screen-edge margin the bubble is clamped within. */
const VIEWPORT_MARGIN = 8;

interface Warmth {
  /** Announce this tooltip as open, closing whichever sibling was up. */
  enter: (close: () => void) => void;
  leave: (close: () => void) => void;
  isWarm: () => boolean;
}

/** No provider means no warmth — a lone tooltip somewhere else in the app always waits the full
 *  delay, and never inherits the toolbar's. */
const COLD: Warmth = { enter: () => {}, leave: () => {}, isWarm: () => false };

const TooltipWarmthContext = createContext<Warmth>(COLD);

/**
 * Scopes "the user is reading tooltips right now" to one cluster of triggers.
 *
 * Deliberately a context and not a module-level timer: module state would be shared by every test
 * in a file (and by unrelated surfaces at runtime), so a group that was warmed in one test would
 * silently defeat the next one's cold-start assertion. A fresh provider per render is cold by
 * construction.
 */
export function TooltipGroup({ children }: { children: ReactNode }) {
  // A ref, not closure variables: this is state that deliberately doesn't re-render anyone, and
  // reassigning captured `let`s after render is exactly what the immutability lint warns about.
  const group = useRef({
    open: 0,
    lastClosedAt: Number.NEGATIVE_INFINITY,
    current: null as (() => void) | null,
  });

  const warmth = useMemo<Warmth>(
    () => ({
      enter: (close) => {
        const state = group.current;
        // At most one tooltip per group. Crossing quickly, the one behind is still inside its
        // hide delay when the next opens; without this they overlap on screen for a moment, which
        // reads as a glitch rather than as speed.
        if (state.current && state.current !== close) state.current();
        state.current = close;
        state.open += 1;
      },
      leave: (close) => {
        const state = group.current;
        state.open -= 1;
        if (state.current === close) state.current = null;
        state.lastClosedAt = Date.now();
      },
      // An open sibling counts: crossing from one trigger to the next, the first hasn't finished
      // its own hide delay yet, so `lastClosedAt` alone would still read cold.
      isWarm: () => {
        const state = group.current;
        return state.open > 0 || Date.now() - state.lastClosedAt < WARM_WINDOW_MS;
      },
    }),
    [],
  );

  return <TooltipWarmthContext value={warmth}>{children}</TooltipWarmthContext>;
}

export interface TooltipTriggerProps {
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: () => void;
  'aria-describedby'?: string;
}

interface TooltipProps {
  content: PrimitiveTooltipContent;
  children: (triggerProps: TooltipTriggerProps) => ReactElement;
}

interface Position {
  top: number;
  left: number;
  placement: 'below' | 'above';
}

/**
 * A viewport-anchored tooltip for toolbar buttons — deliberately not a reuse of the flow-space
 * popovers (`ElementInspectorPopover` and siblings), which anchor to a *canvas node's* position
 * via `@xyflow/react`'s viewport transform. A toolbar button is a plain fixed DOM element, so this
 * anchors directly off its `getBoundingClientRect()` instead.
 *
 * Two densities, one surface. A primitive that needs teaching (`description` present) gets the
 * full card; a conventional action like Undo gets a single row of label + shortcut. They share
 * every token, so the compact one reads as the smaller sibling rather than a second system — the
 * thing a native `title` could never do.
 *
 * Render-prop shaped so it adds zero DOM around its trigger (no layout shift, no dimension
 * change) and needs no `forwardRef` support from the trigger component.
 */
export function Tooltip({ content, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const warmth = useContext(TooltipWarmthContext);
  const id = useId();

  const clearTimers = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  useEffect(() => clearTimers, []);

  // Registered while open so siblings can see the group is warm, and unregistered on close (which
  // is what starts the cool-down) — including on unmount, so a tooltip torn down while up can't
  // leave the group permanently warm.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    warmth.enter(close);
    return () => warmth.leave(close);
  }, [open, warmth]);

  const show = () => {
    clearTimers();
    setOpen(true);
  };

  const scheduleShow = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
      return;
    }
    showTimer.current = window.setTimeout(show, warmth.isWarm() ? WARM_SHOW_DELAY_MS : SHOW_DELAY_MS);
  };

  const scheduleHide = () => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
      return;
    }
    hideTimer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS);
  };

  const close = () => {
    clearTimers();
    setOpen(false);
  };

  // Measured after mount, rounded to whole pixels and only committed when it actually changed —
  // same technique `ElementInspectorPopover` uses to avoid an infinite re-render loop from
  // `getBoundingClientRect`'s sub-pixel float noise.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const anchorRect = anchor.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const fitsBelow = anchorRect.bottom + GAP + bubbleRect.height + VIEWPORT_MARGIN <= window.innerHeight;
    const placement: Position['placement'] = fitsBelow ? 'below' : 'above';
    const top = Math.round(
      placement === 'below' ? anchorRect.bottom + GAP : anchorRect.top - GAP - bubbleRect.height,
    );
    const centered = anchorRect.left + anchorRect.width / 2 - bubbleRect.width / 2;
    const left = Math.round(
      Math.min(Math.max(centered, VIEWPORT_MARGIN), window.innerWidth - bubbleRect.width - VIEWPORT_MARGIN),
    );
    setPosition((current) =>
      current && current.top === top && current.left === left && current.placement === placement
        ? current
        : { top, left, placement },
    );
  });

  const triggerProps: TooltipTriggerProps = {
    onMouseEnter: (event) => {
      anchorRef.current = event.currentTarget;
      scheduleShow();
    },
    onMouseLeave: scheduleHide,
    onFocus: (event) => {
      anchorRef.current = event.currentTarget;
      show();
    },
    onBlur: close,
    onKeyDown: (event) => {
      // No `stopPropagation` — `EditorScreen`'s global Escape handling (e.g. clearing the armed
      // tool) must keep working exactly as it does today; closing the tooltip is purely additive.
      if (event.key === 'Escape' && open) close();
    },
    onPointerDown: close,
    'aria-describedby': open ? id : undefined,
  };

  return (
    <>
      {children(triggerProps)}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className="dc-tooltip"
            data-density={content.description ? 'rich' : 'compact'}
            data-placement={position?.placement ?? 'below'}
            style={{
              position: 'fixed',
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              visibility: position ? 'visible' : 'hidden',
            }}
          >
            <div className="dc-tooltip-header">
              <span className="dc-tooltip-title">{content.title}</span>
              {content.shortcut && (
                <span className="dc-tooltip-keys">
                  {/* One cap per token, the same split `CommandPalette` and `ContextMenu` use, so
                      "⌘ Z" reads as two keys everywhere in the app rather than one wide chip. */}
                  {content.shortcut.split(' ').map((key, index) => (
                    <kbd key={`${key}-${index}`}>{key}</kbd>
                  ))}
                </span>
              )}
            </div>
            {content.description && <p className="dc-tooltip-description">{content.description}</p>}
            {content.usageHint && <p className="dc-tooltip-hint">{content.usageHint}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
