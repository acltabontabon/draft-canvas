import { useReactFlow } from '@xyflow/react';
import { useEffect, type RefObject } from 'react';
import type { RoomAxis } from '../document/makeRoom';
import type { DraftDocument } from '../document/types';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { DRAG_THRESHOLD_PX } from './gestureThresholds';

/** Screen pixels the pointer travels before the drag commits to across or down: past a click's
 *  wobble, and far enough that the first few pixels' direction is the one the hand meant. */
const AXIS_LOCK_PX = DRAG_THRESHOLD_PX * 2;

/**
 * The Make room tool (`document/makeRoom.ts`): armed from the palette, then one drag anywhere on the
 * canvas. Dragging across pushes everything right of the press point away or pulls it back; dragging
 * down does the same to everything below. The whole drag is one undo step, Escape gives it up, and
 * the tool puts itself down after one use — a mode that stayed armed would turn the next ordinary
 * drag into a surprise.
 *
 * Claims the pane with capture listeners, as the Pencil does (`useInkInput.ts`), so the marquee and
 * shape drags underneath never see the gesture.
 */
export function useMakeRoom(paneRef: RefObject<HTMLDivElement | null>): void {
  const armed = useUiStore((state) => state.makeRoom !== null);
  const { screenToFlowPosition } = useReactFlow();
  useEffect(() => {
    const pane = paneRef.current;
    if (!armed || !pane) return;
    let active: {
      pointerId: number;
      client: { x: number; y: number };
      flow: { x: number; y: number };
      axis: RoomAxis | null;
      base: DraftDocument;
      latest: { x: number; y: number };
    } | null = null;
    let frame = 0;
    let dragged = false;

    const push = () => {
      frame = 0;
      if (!active?.axis) return;
      const now = screenToFlowPosition(active.latest);
      const { axis, flow, base } = active;
      const asked = Math.round(now[axis] - flow[axis]);
      useEditorStore.getState().pushRoom(base, { axis, at: flow[axis], delta: asked });
      useUiStore.getState().setMakeRoom({ line: { axis, at: flow[axis], delta: asked } });
    };
    const stop = (keep: boolean) => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      const was = active;
      active = null;
      if (was?.axis) {
        if (keep) useEditorStore.getState().endInteraction('Make room');
        else useEditorStore.getState().abandonInteraction();
      }
      if (was && pane.hasPointerCapture(was.pointerId)) pane.releasePointerCapture(was.pointerId);
      useUiStore.getState().setMakeRoom(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || active) return;
      // The canvas itself, shapes and lines included; never the chrome drawn over it.
      if (!(event.target instanceof Element) || !event.target.closest('.react-flow__renderer')) return;
      event.preventDefault();
      event.stopPropagation();
      const client = { x: event.clientX, y: event.clientY };
      active = { pointerId: event.pointerId, client, flow: screenToFlowPosition(client), axis: null, base: useEditorStore.getState().document, latest: client };
      pane.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      active.latest = { x: event.clientX, y: event.clientY };
      if (!active.axis) {
        const dx = Math.abs(event.clientX - active.client.x);
        const dy = Math.abs(event.clientY - active.client.y);
        if (Math.max(dx, dy) < AXIS_LOCK_PX) return;
        active.axis = dx >= dy ? 'x' : 'y';
        dragged = true;
        useEditorStore.getState().beginInteraction('Make room');
      }
      if (frame === 0) frame = requestAnimationFrame(push);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      active.latest = { x: event.clientX, y: event.clientY };
      if (frame !== 0) cancelAnimationFrame(frame);
      push();
      // A press that never became a drag made no room: the tool stays in hand for a real one.
      if (!active.axis) {
        if (pane.hasPointerCapture(active.pointerId)) pane.releasePointerCapture(active.pointerId);
        active = null;
        return;
      }
      stop(true);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (active && event.pointerId === active.pointerId) stop(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      stop(false);
    };
    // The click that ends the drag must not also reach the canvas as one (it would clear a selection).
    const onClick = (event: MouseEvent) => {
      if (!dragged && !useUiStore.getState().makeRoom) return;
      event.stopPropagation();
    };

    pane.addEventListener('pointerdown', onPointerDown, true);
    pane.addEventListener('pointermove', onPointerMove, true);
    pane.addEventListener('pointerup', onPointerUp, true);
    pane.addEventListener('pointercancel', onPointerCancel, true);
    pane.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      pane.removeEventListener('pointerdown', onPointerDown, true);
      pane.removeEventListener('pointermove', onPointerMove, true);
      pane.removeEventListener('pointerup', onPointerUp, true);
      pane.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('keydown', onKeyDown, true);
      // After the click that follows the releasing pointerup has been swallowed.
      window.setTimeout(() => pane.removeEventListener('click', onClick, true), 0);
      if (active?.axis) useEditorStore.getState().endInteraction('Make room');
      if (frame !== 0) cancelAnimationFrame(frame);
      active = null;
    };
  }, [armed, paneRef, screenToFlowPosition]);
}
