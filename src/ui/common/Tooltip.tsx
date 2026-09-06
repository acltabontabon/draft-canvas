import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { PrimitiveTooltipContent } from '../../canvas/presets';

/** Hover must clear this before the tooltip appears — long enough that a pointer merely
 *  travelling across the toolbar never triggers it. */
const SHOW_DELAY_MS = 400;
/** Grace period after the pointer leaves before the tooltip actually closes, so a brief flicker
 *  off the trigger (e.g. crossing its own border) doesn't retrigger the show delay. */
const HIDE_DELAY_MS = 150;
/** Clears the toolbar's bottom border plus a small margin. */
const GAP = 8;
/** Screen-edge margin the bubble is clamped within. */
const VIEWPORT_MARGIN = 8;

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
  const id = useId();

  const clearTimers = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  };

  useEffect(() => clearTimers, []);

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
    showTimer.current = window.setTimeout(show, SHOW_DELAY_MS);
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
              {content.shortcut && <kbd>{content.shortcut}</kbd>}
            </div>
            <p className="dc-tooltip-description">{content.description}</p>
            {content.usageHint && <p className="dc-tooltip-hint">{content.usageHint}</p>}
          </div>,
          document.body,
        )}
    </>
  );
}
