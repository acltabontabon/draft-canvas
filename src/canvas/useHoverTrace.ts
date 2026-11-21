import { useEffect } from 'react';
import { lineageOf } from '../document/dataFlow';
import { isEditableTarget } from '../lib/isEditableTarget';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/** How long the pointer rests on a shape with Shift held before its lineage lights up: long enough
 *  that a Shift-click to add to the selection, or a capital typed with the pointer resting on a
 *  shape, never flashes the diagram. */
const TRACE_DWELL_MS = 280;

/**
 * Hold Shift and rest the pointer on a shape: everything its data comes from and everything it feeds
 * stays lit, and the rest of the diagram steps back, until Shift is let go or the pointer leaves.
 * The same walk as the "Show lineage" command (`document/dataFlow.ts`), as a glance instead of a
 * mode: nothing is selected, focused, saved or undone. The walk runs once per shape rested on, never
 * per shape drawn — each node and connector only looks its own id up in the resulting set.
 */
export function useHoverTrace(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let at: { x: number; y: number } | null = null;
    let shift = false;
    let resting: string | null = null;
    let timer: number | undefined;
    let frame = 0;

    const clear = () => {
      window.clearTimeout(timer);
      timer = undefined;
      resting = null;
      if (useUiStore.getState().traceIds !== null) useUiStore.getState().setTraceIds(null);
    };
    const probe = () => {
      frame = 0;
      const ui = useUiStore.getState();
      if (!shift || !at || ui.interactionActive || ui.armed || ui.reconnectDragActive) return clear();
      const id = document.elementFromPoint(at.x, at.y)?.closest('.react-flow__node[data-id]')?.getAttribute('data-id') ?? null;
      if (!id) return clear();
      if (id === resting) return;
      clear();
      resting = id;
      timer = window.setTimeout(() => {
        const { nodeIds, edgeIds } = lineageOf(useEditorStore.getState().document, id);
        // A shape nothing flows into or out of has no lineage to show: dimming everything else
        // would only say "nothing".
        if (edgeIds.length > 0) useUiStore.getState().setTraceIds(new Set([...nodeIds, ...edgeIds]));
      }, TRACE_DWELL_MS);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(probe);
    };
    const onMove = (event: PointerEvent) => {
      at = { x: event.clientX, y: event.clientY };
      // A button held is a drag or a marquee, which Shift means something else to.
      const held = event.shiftKey && event.buttons === 0 && event.pointerType !== 'touch';
      if (!held && !shift) return;
      shift = held;
      schedule();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Shift') return;
      shift = event.type === 'keydown' && !isEditableTarget(event.target);
      schedule();
    };
    const onLeave = () => {
      shift = false;
      clear();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onLeave, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onLeave, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onLeave);
      if (frame !== 0) cancelAnimationFrame(frame);
      clear();
    };
  }, [enabled]);
}
