import { useEffect, useState } from 'react';
import { overlayAboveCanvasIsOpen } from '../../lib/isEditableTarget';
import { peekSubject, type PresentationHostKind } from '../../presentation/presentationAttachments';
import { useEditorStore } from '../../store/editorStore';
import { selectEdge, selectNode } from '../../store/selectors';
import { useUiStore } from '../../store/uiStore';

/** How long the pointer rests on a shape before it tells what it carries: long enough that crossing
 *  the diagram on the way somewhere else never opens anything. */
export const PEEK_DWELL_MS = 320;
/** With one already told, the next shape rested on answers sooner — reading along a row of them. */
export const PEEK_SWITCH_MS = 120;
/** How long it stays after the pointer leaves: time to cross the gap onto the callout itself. */
export const PEEK_LINGER_MS = 180;

const PEEK_CALLOUT = '.dc-callout[data-variant="peek"]';

export interface PeekHost {
  hostKind: PresentationHostKind;
  hostId: string;
}

/**
 * Rest the pointer on a shape or connector that carries notes or code and they are told beside it,
 * the way Presentation Mode tells them — no click. Returns what is being told, or null.
 *
 * A glance, never a mode: nothing is selected, pinned, saved or undone, and it steps aside for
 * anything deliberate — a press, a key, a drag, a tool in hand, a selected element (its inspector is
 * already there) or the editing popover. One window listener and one hit test per frame the pointer
 * moves; no shape or connector subscribes to anything.
 */
export function useAttachmentPeek(enabled: boolean): PeekHost | null {
  const [host, setHost] = useState<PeekHost | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let at: { x: number; y: number } | null = null;
    // `node:<id>` / `edge:<id>` — one string to compare, split again only when shown.
    let shown: string | null = null;
    let pending: string | null = null;
    let showTimer: number | undefined;
    let hideTimer: number | undefined;
    let frame = 0;

    const cancelShow = () => {
      window.clearTimeout(showTimer);
      showTimer = undefined;
      pending = null;
    };
    const cancelHide = () => {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    };
    const hide = () => {
      cancelShow();
      cancelHide();
      if (shown !== null) {
        shown = null;
        setHost(null);
      }
    };
    const busy = () => {
      const ui = useUiStore.getState();
      return (
        ui.interactionActive ||
        ui.reconnectDragActive ||
        ui.armed !== null ||
        ui.pencil !== null ||
        ui.dragCapsule !== null ||
        ui.contextMenu !== null ||
        ui.editingTextId !== null ||
        ui.openAttachmentDetail !== null ||
        overlayAboveCanvasIsOpen()
      );
    };
    /** The shape or connector under the pointer, if resting there should tell its attachments. */
    const speakerAt = (under: Element | null): string | null => {
      const { document, selection } = useEditorStore.getState();
      const nodeId = under?.closest('.react-flow__node[data-id]')?.getAttribute('data-id') ?? null;
      if (nodeId) {
        const node = selectNode(document, nodeId);
        if (!node || !peekSubject('node', node) || selection.nodes.includes(nodeId)) return null;
        // A boundary or a sequence diagram is mostly room for other things: resting anywhere inside
        // one is not asking about it. Its own attachment tab is.
        if ((node.type === 'group' || node.type === 'sequence') && !under?.closest('.dc-attachment-badge')) return null;
        return `node:${nodeId}`;
      }
      // A connector is hit by geometry, not by the DOM (`edgePick.ts`): the canvas already knows which
      // one the pointer is on. Its chips are real elements beside the line, and count as it too.
      const edgeId =
        under?.closest('.dc-attachment-chip-row[data-host-id]')?.getAttribute('data-host-id') ??
        (under?.closest('.react-flow') ? useUiStore.getState().hoveredEdgeId : null);
      if (!edgeId) return null;
      const edge = selectEdge(document, edgeId);
      return edge && peekSubject('edge', edge) && !selection.edges.includes(edgeId) ? `edge:${edgeId}` : null;
    };
    const probe = () => {
      frame = 0;
      if (!at) return;
      if (busy()) return hide();
      const under = window.document.elementFromPoint(at.x, at.y);
      // Reading the callout itself keeps it.
      if (shown !== null && under?.closest(PEEK_CALLOUT)) {
        cancelShow();
        cancelHide();
        return;
      }
      const id = speakerAt(under);
      if (id === null) {
        cancelShow();
        if (shown !== null && hideTimer === undefined) hideTimer = window.setTimeout(hide, PEEK_LINGER_MS);
        return;
      }
      if (id === shown) {
        cancelShow();
        cancelHide();
        return;
      }
      if (id === pending) return;
      cancelShow();
      pending = id;
      showTimer = window.setTimeout(
        () => {
          showTimer = undefined;
          pending = null;
          if (busy()) return hide();
          cancelHide();
          shown = id;
          const cut = id.indexOf(':');
          setHost({ hostKind: id.slice(0, cut) as PresentationHostKind, hostId: id.slice(cut + 1) });
        },
        shown === null ? PEEK_DWELL_MS : PEEK_SWITCH_MS,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(probe);
    };
    const onMove = (event: PointerEvent) => {
      // A button held is a drag or a marquee; Shift is the lineage glance (`useHoverTrace`).
      if (event.pointerType === 'touch' || event.buttons !== 0 || event.shiftKey) {
        at = null;
        return hide();
      }
      at = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const onDown = (event: PointerEvent) => {
      // A press inside the callout selects or scrolls its text; anywhere else is something deliberate.
      if (event.target instanceof Element && event.target.closest(PEEK_CALLOUT)) return;
      at = null;
      hide();
    };
    const onAway = () => {
      at = null;
      hide();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    // The canvas panning or zooming under a still pointer changes what it rests on.
    window.addEventListener('wheel', schedule, { passive: true });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onAway, true);
    window.addEventListener('blur', onAway);
    window.document.addEventListener('pointerleave', onAway);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('wheel', schedule);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onAway, true);
      window.removeEventListener('blur', onAway);
      window.document.removeEventListener('pointerleave', onAway);
      if (frame !== 0) cancelAnimationFrame(frame);
      hide();
    };
  }, [enabled]);

  return enabled ? host : null;
}
