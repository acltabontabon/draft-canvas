import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Handle } from '../api';

/** How far a press travels before it is a drag rather than a click that wobbled. */
const THRESHOLD = 6;
/** The ghost is the tile itself, smaller and tipped a little, so it reads as picked up. */
const GHOST_SCALE = 0.5;
/** It trails below and right of the pointer, the way a dragged file does, so the project the pointer
 * is over stays in sight rather than under the ghost. */
const TRAIL = { x: 14, y: 18 };
const SETTLE_MS = 200;

export interface TileDragState<T> {
  item: T;
  /** The project under the pointer that would take it, if any. */
  armed: Handle | null;
}

/**
 * Picking a tile up and dropping it on a project (`[data-drop-project]`). Pointer events, not HTML5
 * drag and drop: the desktop shell's own file drop (`dragDropEnabled`) swallows HTML5 drags on
 * Windows. A press stays a click until it has travelled `THRESHOLD`; once it is a drag, the click it
 * ends in is swallowed, Escape puts the tile back, and a drop anywhere that isn't a project does too.
 *
 * The ghost follows the pointer by its style alone, a frame at a time; React only hears when the drag
 * starts, ends, or moves over a different project.
 */
export function useTileDrag<T>({
  canDrop,
  onDrop,
}: {
  canDrop: (item: T, project: Handle) => boolean;
  onDrop: (item: T, project: Handle, source: HTMLElement) => void;
}) {
  const [drag, setDrag] = useState<TileDragState<T> | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ canDrop, onDrop });
  useLayoutEffect(() => {
    latest.current = { canDrop, onDrop };
  });
  const stop = useRef<(() => void) | null>(null);
  // A drag still under way when the view unmounts (a scope switch that drops the grid) ends with it.
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, item: T, source: HTMLElement) => {
    // A mouse or pen: a finger's press-and-move is the page scrolling.
    if (event.button !== 0 || event.pointerType === 'touch' || stop.current) return;
    const start = { x: event.clientX, y: event.clientY };
    const rect = source.getBoundingClientRect();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let dragging = false;
    let armed: Handle | null = null;
    let frame = 0;
    let at = start;

    const place = () => {
      frame = 0;
      const ghost = ghostRef.current;
      if (!ghost) return;
      const x = at.x + TRAIL.x;
      const y = at.y + TRAIL.y;
      ghost.style.width = `${rect.width}px`;
      ghost.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(-2.5deg) scale(${GHOST_SCALE})`;
      // Hidden until it has a place, so it never flashes at the window's corner on its first frame.
      ghost.dataset.placed = '';
    };

    const onMove = (move: PointerEvent) => {
      at = { x: move.clientX, y: move.clientY };
      if (!dragging) {
        if (Math.hypot(at.x - start.x, at.y - start.y) < THRESHOLD) return;
        dragging = true;
        source.dataset.dragSource = '';
        document.documentElement.dataset.tileDragging = '';
        window.getSelection()?.removeAllRanges();
        setDrag({ item, armed: null });
      }
      move.preventDefault();
      if (!frame) frame = requestAnimationFrame(place);
      const over = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>('[data-drop-project]')?.dataset.dropProject ?? null;
      const next = over && latest.current.canDrop(item, over) ? over : null;
      if (next !== armed) {
        armed = next;
        setDrag({ item, armed });
      }
    };

    const detach = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancel);
      if (frame) cancelAnimationFrame(frame);
      stop.current = null;
    };

    const finish = () => {
      delete source.dataset.dragSource;
      delete document.documentElement.dataset.tileDragging;
      setDrag(null);
    };

    /** The ghost goes to `to` (shrinking into a project, or back to its tile), then the drag ends. */
    const settle = (to: { x: number; y: number; scale: number; opacity: number }) => {
      const ghost = ghostRef.current;
      if (reduced || !ghost) return finish();
      ghost.style.transition = `transform ${SETTLE_MS}ms var(--dc-ease-out), opacity ${SETTLE_MS}ms var(--dc-ease-out)`;
      ghost.style.transform = `translate3d(${to.x}px, ${to.y}px, 0) scale(${to.scale})`;
      ghost.style.opacity = String(to.opacity);
      window.setTimeout(finish, SETTLE_MS);
    };

    function cancel() {
      detach();
      if (!dragging) return;
      // Back where it came from, full size, as if set down again.
      const home = source.getBoundingClientRect();
      settle({ x: home.left, y: home.top, scale: 1, opacity: 0.4 });
    }

    function onUp() {
      detach();
      if (!dragging) return;
      // The press began on the tile's button: the click it ends in is the drag's, not an Open.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      if (!armed) {
        const home = source.getBoundingClientRect();
        return settle({ x: home.left, y: home.top, scale: 1, opacity: 0.4 });
      }
      const target = document.querySelector<HTMLElement>(`[data-drop-project="${CSS.escape(armed)}"]`)?.getBoundingClientRect();
      latest.current.onDrop(item, armed, source);
      if (!target) return finish();
      settle({ x: target.left + target.width / 2 - 12, y: target.top + target.height / 2 - 10, scale: 0.12, opacity: 0 });
    }

    function onKey(key: KeyboardEvent) {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      cancel();
    }

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    stop.current = () => {
      detach();
      if (dragging) finish();
    };
  };

  return { drag, ghostRef, onPointerDown };
}
