import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useStore } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore';
import { selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { rectOfInternal } from './edgeGeometry';
import { AttachmentChipRow, type AttachmentActions } from './AttachmentPresentation';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type Placement,
  type PlacementClearances,
} from './popoverPlacement';
import { useOverlayPosition } from './useOverlayPosition';
import { useLastPresent, usePopoverPresence } from './usePopoverPresence';
import { useToolbarHeight } from './useToolbarHeight';

/** Must match the `dc-attachment-card-in`/`-out` keyframe duration in `canvas.css`. */
const POPOVER_EXIT_MS = 120;

/** Same basis as `ElementInspectorPopover`'s own clearances — independently declared (not
 *  imported) so tuning one popover's fit can never regress another's, the same isolation
 *  `EdgeInspectorPopover.tsx` already established as house style for this codebase. */
const GAP = 14;
const TOP_CLEARANCE = 56;
const BOTTOM_CLEARANCE = 44;
const LEFT_CLEARANCE = 12;
const RIGHT_CLEARANCE_WITH_FLOW_PANEL = 312;

/**
 * The contextual popover a node's attachment badge opens — anchored at the node's own rendered
 * bounds (`popoverPlacement.ts`'s collision-aware beside/above/below/left/right search, the same
 * algorithm `ElementInspectorPopover` uses for its own placement) rather than a fixed offset, and
 * hosting the same chip/card presentation `DraftEdgeView.tsx` uses for connector attachments
 * (`AttachmentChipRow`/`AttachmentChip` from `AttachmentPresentation.tsx`) instead of a separate,
 * always-expanded list UI.
 */
export function AttachmentPopover() {
  // Presenting never opens this popover at all — see the matching comment on the badge itself in
  // `DraftNodeView.tsx`. Gating here, at the source, is what makes entering Presentation Mode while
  // the popover happens to already be open close it automatically too: `open` below depends on
  // `hostId`, so it simply goes false the same way it would on an outside click.
  const openDetail = useUiStore((state) => state.openAttachmentDetail);
  const presenting = useEditorStore((state) => state.mode === 'present');
  const hostId = !presenting && openDetail?.hostKind === 'node' ? openDetail.hostId : null;
  const hasAttachments = useEditorStore((state) =>
    hostId ? Boolean(selectNode(state.document, hostId)?.attachments?.length) : false,
  );
  const measured = useStore((state) => (hostId ? state.nodeLookup.has(hostId) : false));
  const setOpenAttachmentDetail = useUiStore((state) => state.setOpenAttachmentDetail);

  // Detaching or deleting the last attachment must close the popover, not
  // just stop rendering it — otherwise the open state lingers and the next
  // click on the badge (which toggles) reads as "already open" and closes
  // instead of opening.
  const hostExists = useEditorStore((state) => (hostId ? selectNode(state.document, hostId) !== undefined : false));
  useEffect(() => {
    if (hostId && hostExists && !hasAttachments) setOpenAttachmentDetail(null);
  }, [hostId, hostExists, hasAttachments, setOpenAttachmentDetail]);

  const open = Boolean(hostId && hasAttachments && measured);
  const { mounted, closing } = usePopoverPresence(open, POPOVER_EXIT_MS);
  const shownHostId = useLastPresent(open ? hostId : null);
  if (!mounted || !shownHostId) return null;
  return <AttachmentPopoverBody hostId={shownHostId} closing={closing} listening={hostId !== null} />;
}

function AttachmentPopoverBody({ hostId, closing, listening }: { hostId: string; closing: boolean; listening: boolean }) {
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const interactionActive = useUiStore((state) => state.interactionActive);
  const setOpenAttachmentDetail = useUiStore((state) => state.setOpenAttachmentDetail);
  const rightClearance = flowPanelOpen ? RIGHT_CLEARANCE_WITH_FLOW_PANEL : LEFT_CLEARANCE;
  const liveHost = useEditorStore((state) => selectNode(state.document, hostId));
  const liveInternal = useInternalNode(hostId);
  const updateAttachment = useEditorStore((state) => state.updateAttachment);
  const removeAttachment = useEditorStore((state) => state.removeAttachment);
  const detachAttachment = useEditorStore((state) => state.detachAttachment);
  const reorderAttachment = useEditorStore((state) => state.reorderAttachment);

  const panelRef = useRef<HTMLDivElement>(null);

  // The last live host and its position, kept for the panel to keep rendering *something*
  // coherent while it fades out, instead of going blank a frame early.
  const shown = useLastPresent(
    liveHost?.attachments?.length && liveInternal ? { host: liveHost, internal: liveInternal } : null,
  );

  // Closes the whole popover (row and any pinned card together) on Escape or a click genuinely
  // outside it. An individual chip's own card also has this same pattern scoped to just that chip
  // (see `AttachmentChip` in `AttachmentPresentation.tsx`) — the two don't conflict: both may fire
  // for the same event (plain `stopPropagation` on one `window` listener does not suppress a
  // sibling listener on the same target), and both end up wanting `openAttachmentDetail` cleared
  // regardless, so a harmless redundant call is the worst case, not a race.
  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpenAttachmentDetail(null);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpenAttachmentDetail(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [listening, setOpenAttachmentDetail]);

  const displayHost = shown?.host;
  const attachments = displayHost?.attachments ?? [];
  const rect = shown ? rectOfInternal(shown.internal) : null;

  // Measured, not a constant: the toolbar wraps to two rows on narrow viewports.
  const toolbarHeight = useToolbarHeight(true);
  const clearances: PlacementClearances = {
    gap: GAP,
    top: toolbarHeight ? toolbarHeight + 10 : TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: rightClearance,
  };
  const anchors = rect ? anchorsForRect(rect) : null;

  // Same "only re-picks placement when the current one genuinely stops fitting" stability rule, and
  // the same freeze while a gesture is in flight, as `ElementInspectorPopover` — keeps this from
  // flipping (or oscillating) mid-drag or mid-resize.
  const { target, placement } = useOverlayPosition<Placement>(panelRef, 'right', (frame, current) => {
    if (!anchors) return null;
    const next = interactionActive
      ? current
      : resolvePlacement(current, anchors, frame.flowToScreenPosition, frame.size, clearances);
    return {
      placement: next,
      transform: placementTransform(next, anchors, frame.size, clearances, frame.flowToScreenPosition, frame.screenToOverlay),
    };
  });

  if (!displayHost || !attachments.length || !anchors || !target) return null;

  const attachmentActions: AttachmentActions = {
    update: (attachmentId, patch) => updateAttachment(displayHost.id, attachmentId, patch),
    remove: (attachmentId) => removeAttachment(displayHost.id, attachmentId),
    detach: (attachmentId) => detachAttachment(displayHost.id, attachmentId),
    reorder: (attachmentId, direction) => reorderAttachment(displayHost.id, attachmentId, direction),
  };
  // A dropdown/card should open away from the node, mirroring whichever side the popover itself
  // placed on — 'left'/'right' placement has no above/below relationship to the node at all, so
  // 'below' is the sensible default there, same precedent as `ElementInspectorPopover`'s own
  // `menuDirection` default in the same situation.
  const cardSide: 'above' | 'below' = placement === 'above' ? 'above' : 'below';

  return createPortal(
      <div
        ref={panelRef}
        className="dc-attachment-popover"
        role="dialog"
        aria-label={`Attachments for ${displayHost.text || 'this node'}`}
        data-closing={closing ? 'true' : undefined}
        data-placement={placement}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* The reveal/close animation lives on this inner wrapper, not the positioned outer div —
            a CSS animation replaces the whole `transform` property for its duration, so animating
            scale here would otherwise clobber the outer div's own positioning translate. */}
        <div className="dc-attachment-popover-inner">
          <AttachmentChipRow
            hostKind="node"
            hostId={displayHost.id}
            attachments={attachments}
            cardSide={cardSide}
            editable
            actions={attachmentActions}
          />
        </div>
      </div>,
    target,
  );
}
