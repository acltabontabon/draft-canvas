import { useEffect, useRef, useState } from 'react';

/**
 * Delayed unmount for a popover's exit animation: `mounted` stays true for `exitMs` after `open`
 * turns false, with `closing` true for that window so CSS can play the reverse animation instead
 * of the panel vanishing mid-frame. Reduced motion skips the wait.
 *
 * Lets a popover's outer shell subscribe to nothing but whether it's open, and mount the body —
 * with its whole-document subscriptions — only while there's something to show.
 */
export function usePopoverPresence(open: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [lingering, setLingering] = useState(open);
  if (open && !lingering) setLingering(true);

  useEffect(() => {
    if (open || !lingering) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => setLingering(false), reduceMotion ? 0 : exitMs);
    return () => window.clearTimeout(timer);
  }, [open, lingering, exitMs]);

  return { mounted: open || lingering, closing: !open && lingering };
}

/**
 * `value` while it's present, otherwise the last present value — what a popover keeps rendering
 * while it fades out after its element was deselected or deleted. A ref, not state: the live value
 * can change every animation frame (a dragged node's internals) and must not cost a second render.
 */
export function useLastPresent<T>(value: T | null | undefined): T | undefined {
  const last = useRef(value ?? undefined);
  // oxlint-disable-next-line react/refs -- a render-time cache of the last present value, by design.
  if (value != null) last.current = value;
  // oxlint-disable-next-line react/refs -- see above.
  return value ?? last.current;
}
