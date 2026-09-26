import { useEffect, useRef } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';

/**
 * The presenter's pointer: a soft ring that follows the cursor over the canvas while it is on
 * (`uiStore.presentation.pointer` — the strip's Pointer control, or `P`), for calling attention
 * to an area without a laser. Screen-space chrome beside React Flow, never inside it: it neither
 * pans with the diagram nor takes a pointer event from it, and its position is written straight to
 * the DOM on every move — a React render per pointer frame would be the one thing a presentation
 * can't afford. Comes off with the mode, so nothing is left listening.
 */
export function PresentationPointer() {
  const on = useUiStore((state) => state.presentation.pointer);
  const presenting = useEditorStore((state) => state.mode === 'present');
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ring = ringRef.current;
    if (!on || !presenting || !ring) return;
    const pane = ring.parentElement;
    if (!pane) return;
    let frame = 0;
    let x = -1000;
    let y = -1000;
    const paint = () => {
      frame = 0;
      ring.style.transform = `translate(${x}px, ${y}px)`;
    };
    const onMove = (event: PointerEvent) => {
      const rect = pane.getBoundingClientRect();
      x = event.clientX - rect.left;
      y = event.clientY - rect.top;
      ring.dataset.shown = 'true';
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onLeave = () => {
      delete ring.dataset.shown;
    };
    pane.addEventListener('pointermove', onMove);
    pane.addEventListener('pointerleave', onLeave);
    return () => {
      pane.removeEventListener('pointermove', onMove);
      pane.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      delete ring.dataset.shown;
    };
  }, [on, presenting]);

  if (!on || !presenting) return null;
  return <div ref={ringRef} className="dc-present-pointer" aria-hidden="true" />;
}
