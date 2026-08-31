import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ViewportPortal, useInternalNode, useReactFlow } from '@xyflow/react';
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
  const openDetail = useUiStore((state) => state.openAttachmentDetail);
  const mode = useEditorStore((state) => state.mode);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const setOpenAttachmentDetail = useUiStore((state) => state.setOpenAttachmentDetail);
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();
  const rightClearance = flowPanelOpen ? RIGHT_CLEARANCE_WITH_FLOW_PANEL : LEFT_CLEARANCE;

  // Presenting never opens this popover at all — see the matching comment on the badge itself in
  // `DraftNodeView.tsx`. Gating here, at the source, is what makes entering Presentation Mode while
  // the popover happens to already be open close it automatically too: `open` below depends on
  // `hostId`, so it simply goes false the same way it would on an outside click.
  const hostId = mode !== 'present' && openDetail?.hostKind === 'node' ? openDetail.hostId : null;
  const host = useEditorStore((state) => (hostId ? selectNode(state.document, hostId) : undefined));
  const internal = useInternalNode(hostId ?? '');
  const updateAttachment = useEditorStore((state) => state.updateAttachment);
  const removeAttachment = useEditorStore((state) => state.removeAttachment);
  const detachAttachment = useEditorStore((state) => state.detachAttachment);
  const reorderAttachment = useEditorStore((state) => state.reorderAttachment);

  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>('right');

  // Detaching or deleting the last attachment must close the popover, not
  // just stop rendering it — otherwise the open state lingers and the next
  // click on the badge (which toggles) reads as "already open" and closes
  // instead of opening.
  useEffect(() => {
    if (hostId && host && !host.attachments?.length) setOpenAttachmentDetail(null);
  }, [hostId, host, setOpenAttachmentDetail]);

  const open = Boolean(hostId && host?.attachments?.length && internal);

  // Same delayed-unmount fade `ElementInspectorPopover`/`EdgeInspectorPopover` use: the panel
  // stays mounted one more tick after `open` flips false so `canvas.css` can play the reverse
  // animation instead of the DOM node vanishing mid-frame.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const hideTimer = useRef<number | null>(null);

  // Self-measured, not guessed: fit checks depend on the popover's own current width and height —
  // see `ElementInspectorPopover`'s identical comment on why this re-measures every render.
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.width > 0 && rect.height > 0 && (rect.width !== measuredSize.width || rect.height !== measuredSize.height)) {
      setMeasuredSize({ width: rect.width, height: rect.height });
    }
  });

  // `host`/`host.attachments`/`internal` go away the instant `open` flips false (the store id is
  // cleared, or the node itself was deleted) — so the last live values are cached here for the
  // panel to keep rendering *something* coherent while it fades out, instead of going blank a
  // frame early.
  const lastHostRef = useRef(host);
  const lastInternalRef = useRef(internal);
  const lastAttachmentsRef = useRef(host?.attachments);
  if (open) {
    lastHostRef.current = host;
    lastInternalRef.current = internal;
    lastAttachmentsRef.current = host?.attachments;
  }

  useEffect(() => {
    if (open) {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setClosing(false);
      setMounted(true);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hideTimer.current = window.setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
        hideTimer.current = null;
      },
      reduceMotion ? 0 : POPOVER_EXIT_MS,
    );
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    // mounted intentionally excluded: it's only ever flipped by this effect's own timeout, so
    // reacting to it here would just re-run the same branch redundantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Closes the whole popover (row and any pinned card together) on Escape or a click genuinely
  // outside it. An individual chip's own card also has this same pattern scoped to just that chip
  // (see `AttachmentChip` in `AttachmentPresentation.tsx`) — the two don't conflict: both may fire
  // for the same event (plain `stopPropagation` on one `window` listener does not suppress a
  // sibling listener on the same target), and both end up wanting `openAttachmentDetail` cleared
  // regardless, so a harmless redundant call is the worst case, not a race.
  useEffect(() => {
    if (!hostId) return;
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
  }, [hostId, setOpenAttachmentDetail]);

  const displayHost = open ? host : lastHostRef.current;
  const displayInternal = open ? internal : lastInternalRef.current;
  const attachments = (open ? host?.attachments : lastAttachmentsRef.current) ?? [];
  const rect = displayInternal ? rectOfInternal(displayInternal) : null;

  const clearances: PlacementClearances = {
    gap: GAP,
    top: TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: rightClearance,
  };
  const anchors = rect ? anchorsForRect(rect) : null;

  // Same "only re-picks placement when the current one genuinely stops fitting" stability rule
  // `ElementInspectorPopover` uses — keeps this from flipping mid-drag or mid-resize.
  const effectivePlacement = anchors
    ? resolvePlacement(placement, anchors, flowToScreenPosition, measuredSize, clearances)
    : placement;
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (effectivePlacement !== placement) setPlacement(effectivePlacement);
  });

  const attachmentActions: AttachmentActions | null = displayHost
    ? {
        update: (attachmentId, patch) => updateAttachment(displayHost.id, attachmentId, patch),
        remove: (attachmentId) => removeAttachment(displayHost.id, attachmentId),
        detach: (attachmentId) => detachAttachment(displayHost.id, attachmentId),
        reorder: (attachmentId, direction) => reorderAttachment(displayHost.id, attachmentId, direction),
      }
    : null;

  if (!mounted) return null;
  if (!displayHost || !attachments.length || !anchors || !attachmentActions) return null;

  const transform = placementTransform(
    effectivePlacement,
    anchors,
    measuredSize,
    clearances,
    flowToScreenPosition,
    screenToFlowPosition,
  );
  // A dropdown/card should open away from the node, mirroring whichever side the popover itself
  // placed on — 'left'/'right' placement has no above/below relationship to the node at all, so
  // 'below' is the sensible default there, same precedent as `ElementInspectorPopover`'s own
  // `menuDirection` default in the same situation.
  const cardSide: 'above' | 'below' = effectivePlacement === 'above' ? 'above' : 'below';

  return (
    <ViewportPortal>
      <div
        ref={panelRef}
        className="dc-attachment-popover"
        role="dialog"
        aria-label={`Attachments for ${displayHost.text || 'this node'}`}
        data-closing={closing ? 'true' : undefined}
        style={{ transform }}
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
            editable={mode !== 'present'}
            actions={attachmentActions}
          />
        </div>
      </div>
    </ViewportPortal>
  );
}
