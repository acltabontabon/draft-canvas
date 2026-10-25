import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** Keeps a moved canvas popup where the person leaves it, inside the visible canvas. */
export function usePopoverDrag(ref: RefObject<HTMLElement | null>, owner: string) {
  const [moved, setMoved] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number; right: number; bottom: number; startX: number; startY: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    drag.current = null;
    offset.current = { x: 0, y: 0 };
    if (ref.current) ref.current.style.translate = '';
    // A recovery sidecar can switch actions without unmounting the host editor.
    // oxlint-disable-next-line react/set-state-in-effect
    setMoved(false);
  }, [owner, ref]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !ref.current) return;
    event.preventDefault();
    event.stopPropagation();
    const panel = ref.current.getBoundingClientRect();
    const canvas = ref.current.closest('.react-flow')?.getBoundingClientRect();
    const bounds = canvas ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: bounds.left + 8 - panel.left,
      top: bounds.top + 8 - panel.top,
      right: bounds.right - 8 - panel.right,
      bottom: bounds.bottom - 8 - panel.bottom,
      startX: offset.current.x,
      startY: offset.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setMoved(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || !ref.current) return;
    const dx = Math.max(current.left, Math.min(current.right, event.clientX - current.x));
    const dy = Math.max(current.top, Math.min(current.bottom, event.clientY - current.y));
    offset.current = { x: current.startX + dx, y: current.startY + dy };
    ref.current.style.translate = `${offset.current.x}px ${offset.current.y}px`;
  };

  const onPointerUp = () => { drag.current = null; };
  const pin = () => {
    const panel = ref.current;
    const canvas = panel?.closest('.react-flow');
    if (!panel || !canvas) return;
    const box = panel.getBoundingClientRect();
    const root = canvas.getBoundingClientRect();
    // A percent-based anchor makes a growing textarea pull its own resize handle away from the
    // pointer. Fix the panel's current top-left in screen space for this manual sizing gesture.
    panel.style.translate = '';
    offset.current = { x: 0, y: 0 };
    panel.style.transform = `translate(${box.left - root.left}px, ${box.top - root.top}px)`;
    setMoved(true);
  };
  return { moved, pin, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}
