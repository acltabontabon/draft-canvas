import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ViewportPortal, useInternalNode, useReactFlow } from '@xyflow/react';
import {
  ACCENTS,
  CONNECTOR_KINDS,
  EDGE_SEMANTICS,
  type ConnectorKind,
  type DraftEdge,
  type DraftFlow,
  type DraftNode,
  type EdgeSemantic,
} from '../document/types';
import { stepIndexOf } from '../document/flow';
import {
  capabilityFor,
  categoryOf,
  defaultsToResponse,
  isSyncPairing,
  quickFixesFor,
  resolveTransparentCategory,
  type ConnectionCapability,
} from '../document/connectorSemantics';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import { laneIndex, routeBetween, type Rect } from '../edges/routing';
import { routingPlan } from '../edges/bundles';
import type { HintId } from '../learning/hints';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { edgeIndex, nodeIndex } from '../store/selectors';
import { useThemeValue } from '../ui/theme/useTheme';
import { Button } from '../ui/common/Button';
import {
  attachmentRowBelowsSourceOrTarget,
  clampPopoverCenterX,
  rectOfInternal,
  type ScreenRect,
} from './edgeGeometry';
import { HintStrip } from './HintStrip';
import { InspectorSelect, type InspectorSelectOption } from './InspectorSelect';

const EDGE_SEMANTIC_LABELS: Record<EdgeSemantic, string> = {
  http: 'HTTP',
  grpc: 'gRPC',
  event: 'Event',
  command: 'Command',
  query: 'Query',
  reads: 'Reads',
  writes: 'Writes',
  publishes: 'Publishes',
  consumes: 'Consumes',
  calls: 'Calls',
  dependsOn: 'Depends on',
  uses: 'Uses',
  fansOut: 'Fans out',
  deliversTo: 'Delivers to',
  ingests: 'Ingests',
  replicates: 'Replicates',
  cdc: 'CDC',
  syncs: 'Syncs',
  deadLetters: 'Dead-letters to',
  invalidates: 'Invalidates',
  watches: 'Watches',
  searches: 'Searches',
  indexes: 'Indexes',
  routes: 'Routes',
  triggers: 'Triggers',
  implementedBy: 'Implemented by',
  compensates: 'Compensates',
};

const CONNECTOR_KIND_LABELS: Record<ConnectorKind, string> = {
  sync: 'Sync',
  async: 'Async',
  event: 'Event',
  callback: 'Callback',
  conditional: 'Conditional',
  retry: 'Retry',
  failure: 'Failure',
  fallback: 'Fallback',
};

/** Must match this component's own `dc-edge-inspector-*` CSS animation duration. */
const POPOVER_EXIT_MS = 120;

/**
 * Gap between the connector's own label point and the popover. Deliberately larger than
 * `EdgeAttachmentRow`'s 12px: that row sits right at the label point because nothing else lives
 * there, but this popover's anchor point is also where the request label itself now renders
 * (tight to its line, by design) — a 12px gap put the two directly on top of each other. 28px
 * clears a typical single-line label chip's own height plus its line clearance.
 */
const POPOVER_GAP = 28;

/** The toolbar's own height (`--dc-bar-height` in `tokens.css`) plus a small margin — sitting
 *  above the connector must never mean sitting *behind* the toolbar. */
const TOOLBAR_CLEARANCE = 56;

/**
 * The contextual control for a single selected connector — anchored at its
 * own label point instead of docked at the bottom of the screen (the thing
 * `Inspector.tsx`'s old `EdgeControls`/`EdgeFlowMembership` did). Mounted
 * only while exactly one edge, and no node, is selected; `Inspector` itself
 * no longer renders anything for that case, so this is the only edge UI a
 * single-connector selection shows.
 *
 * Selecting a connector shows its full contextual editor immediately — no extra "More options"
 * step. The compact header (label, flow-membership chip) sits above sections (Interaction,
 * Request/Response, Route, Style) that only include what's relevant to *this* connector's actual
 * pairing — see `ExpandedPanel`'s own comment. "+ Flow" is the one remaining, genuinely optional
 * disclosure: a small membership checklist, since listing every flow permanently would be the
 * wrong default for a document with several.
 */
export function EdgeInspectorPopover() {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const store = useEditorStore;
  const theme = useThemeValue();
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();

  const edgeId = selection.nodes.length === 0 && selection.edges.length === 1 ? selection.edges[0] : null;
  const edge = edgeId ? edgeIndex(document.edges).get(edgeId) : undefined;
  const sourceInternal = useInternalNode(edge?.source ?? '');
  const targetInternal = useInternalNode(edge?.target ?? '');

  const open = mode !== 'present' && Boolean(edge && sourceInternal && targetInternal);

  // Same delayed-unmount fade `AttachmentPopover`/`EdgeAttachmentChip` use:
  // the popover stays mounted one more tick after `open` flips false so
  // `canvas.css` can play the reverse animation instead of the DOM node
  // vanishing mid-frame.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // A real measurement, not a guess: which side to sit on (see the `flipBelow` calculation
  // below) depends on the popover's own height, and that varies a lot between the compact row
  // and the expanded editor's several sections. Re-measures after every render — cheap (one
  // `getBoundingClientRect` read) and guarded so it only ever triggers a re-render when the
  // height actually changed, converging in at most one extra frame whenever content changes.
  //
  // Rounded to whole pixels before comparing: `getBoundingClientRect` returns sub-pixel floats
  // that can differ by a fraction of a pixel between two renders of the same genuinely-settled
  // layout — often while a resize or zoom is also driving `useReactFlow()`'s viewport transform.
  // An exact `!==` on that noise never reaches a fixed point (see `ElementInspectorPopover.tsx`'s
  // identical fix, where this was directly observed chaining into React's "Maximum update depth
  // exceeded" crash). Whole pixels are the coarsest resolution anything here is ever laid out or
  // visually distinguishable at, so rounding away that noise costs nothing.
  const [measuredHeight, setMeasuredHeight] = useState(0);
  // Same reasoning as `measuredHeight`, for the horizontal collision guard below — the panel's
  // `max-width: 320px` (canvas.css) means width varies far less than height, but a short
  // connector's label point can still sit close enough to its own source/target that even the
  // panel's *minimum* width reaches into one of them.
  const [measuredWidth, setMeasuredWidth] = useState(0);
  // Deliberately no dependency array — this must re-measure after every render (content height
  // can change for reasons with no single dependency to name: a new section appearing, a
  // multi-line label). The `height !== measuredHeight` guard is what keeps this from looping.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    const height = Math.round(rect?.height ?? 0);
    const width = Math.round(rect?.width ?? 0);
    if (height > 0 && height !== measuredHeight) setMeasuredHeight(height);
    if (width > 0 && width !== measuredWidth) setMeasuredWidth(width);
  });

  // Cached so the popover keeps rendering the connector it was showing while
  // it fades out, instead of going blank the instant selection changes.
  const lastEdgeRef = useRef(edge);
  const lastSourceRef = useRef(sourceInternal);
  const lastTargetRef = useRef(targetInternal);
  if (open) {
    lastEdgeRef.current = edge;
    lastSourceRef.current = sourceInternal;
    lastTargetRef.current = targetInternal;
  }

  // Selecting a *different* connector while the membership checklist is open must close it —
  // otherwise it keeps showing the connector it was opened for. This is not covered by the
  // `open`-keyed effect below: clicking straight from one edge to another never makes `open`
  // itself go false, since a new edge is selected in the same tick the old one is deselected.
  useEffect(() => {
    setMembershipOpen(false);
  }, [edgeId]);

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
    setMembershipOpen(false);
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
    // mounted intentionally excluded — see AttachmentPopover's identical comment.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes the open membership checklist first, without touching the selection — the
  // global Escape handler still clears selection on a second press. Click-away closes it the
  // same way, but never deselects.
  useEffect(() => {
    if (!membershipOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // This listener runs in the *capture* phase (see the `addEventListener` call below) so
      // it reliably beats the app's own global Escape-deselect handler regardless of mount
      // order — but capture on `window` necessarily fires before the event ever reaches an
      // open `InspectorSelect` menu's own (bubble-phase) Escape handling, no matter which
      // mounted first. Defer to it when one is open: closing just the menu, not the whole
      // checklist, is what a single Escape press should do there.
      // `window.document`, not the bare global: this component's own top-level `document` is
      // the store's `DraftDocument`, shadowing it.
      if (window.document.querySelector('.dc-inspector-select-menu')) return;
      event.stopPropagation();
      setMembershipOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setMembershipOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [membershipOpen]);

  if (!mounted) return null;
  const displayEdge = open ? edge : lastEdgeRef.current;
  const displaySource = open ? sourceInternal : lastSourceRef.current;
  const displayTarget = open ? targetInternal : lastTargetRef.current;
  if (!displayEdge || !displaySource || !displayTarget) return null;

  const sourceRect = rectOfInternal(displaySource);
  const targetRect = rectOfInternal(displayTarget);
  if (!sourceRect || !targetRect) return null;

  // The third caller of `routeBetween`, alongside the live edge component and
  // the exporter — and it has to route the connector the same way they do, or
  // the panel anchors to a point the line never passes through. `lane` was
  // already missing here (harmless while the drift was a few pixels); a shared
  // trunk makes it matter, since an un-bundled label point sits out in open
  // canvas far from the branch the user actually clicked.
  const route = routeBetween(sourceRect, targetRect, displayEdge.routing, {
    anchors: { source: displayEdge.sourceAnchor, target: displayEdge.targetAnchor },
    lane: laneIndex(document.edges).get(displayEdge.id)?.offset ?? 0,
    spine: routingPlan(document.nodes, document.edges).spineFor(displayEdge.id),
  });
  // Two independent reasons to prefer sitting below the connector instead of above it: the
  // node-overlap heuristic every popover/attachment row already shares (a short connector whose
  // label point sits close to its own source/target), and — new here, since the expanded editor
  // is tall enough to matter — not enough screen room above the label point before the toolbar.
  // `measuredHeight` starts at 0 (nothing measured yet, e.g. the very first frame after
  // selecting an edge), which always reads as "enough room" — a brief default that self-corrects
  // one frame later once `useLayoutEffect` reports the real height, never a lasting wrong guess.
  const screenLabelPoint = flowToScreenPosition({ x: route.labelX, y: route.labelY });
  // Measured, not guessed: the toolbar wraps to two rows below 720px (see app.css's
  // `@media (max-width: 720px)` block), and a long diagram title can force that wrap even above
  // it — a static constant can't account for either. `TOOLBAR_CLEARANCE` stays as the fallback
  // for the (rare) frame where `.dc-toolbar` isn't in the DOM yet.
  const measuredToolbarHeight = window.document.querySelector('.dc-toolbar')?.getBoundingClientRect().height;
  const toolbarClearance = measuredToolbarHeight ? measuredToolbarHeight + 10 : TOOLBAR_CLEARANCE;
  const notEnoughRoomAbove = screenLabelPoint.y - POPOVER_GAP - measuredHeight < toolbarClearance;
  const flipBelow =
    attachmentRowBelowsSourceOrTarget(route.labelX, route.labelY, sourceRect, targetRect) || notEnoughRoomAbove;

  // Horizontal collision guard: `attachmentRowBelowsSourceOrTarget` above only checks a single
  // point at the label's own x, so it can't see the popover's actual *width* reaching sideways
  // into a neighbour — exactly what happens on a short connector between two nearby nodes (the
  // label point itself sits in open canvas, but the panel is several times wider than the gap).
  // Computed in screen space, since that's what both the node rects and the panel's own measured
  // size are naturally in, then converted back to the flow x the transform below already uses.
  const toScreenRect = (rect: Rect): ScreenRect => {
    const topLeft = flowToScreenPosition({ x: rect.x, y: rect.y });
    const bottomRight = flowToScreenPosition({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
  };
  const popoverScreenTop = flipBelow ? screenLabelPoint.y + POPOVER_GAP : screenLabelPoint.y - POPOVER_GAP - measuredHeight;
  const popoverScreenBottom = flipBelow ? screenLabelPoint.y + POPOVER_GAP + measuredHeight : screenLabelPoint.y - POPOVER_GAP;
  const clampedScreenX = clampPopoverCenterX(
    screenLabelPoint.x,
    measuredWidth / 2,
    POPOVER_GAP,
    popoverScreenTop,
    popoverScreenBottom,
    [toScreenRect(sourceRect), toScreenRect(targetRect)],
  );
  const labelFlowX = screenToFlowPosition({ x: clampedScreenX, y: screenLabelPoint.y }).x;

  const sourceDraftNode = nodeIndex(document.nodes).get(displayEdge.source);
  const targetDraftNode = nodeIndex(document.nodes).get(displayEdge.target);

  // Phase 7.1/7.2 — retires the moment any connector's semantics have been explicitly touched
  // (`semanticsOrigin: 'explicit'`, already stamped by `setEdgeSemantic`/`setEdgeHasResponse`/
  // `setEdgeKind`), not just on dismissal — the existing, precise signal for "the user has already
  // worked with what a connector can mean," not a new field invented for this.
  const hasExplicitSemantics = document.edges.some((e) => e.semanticsOrigin === 'explicit');
  // The same underlying capability (Phase 2.7's drag-to-attach) whichever kind of element taught
  // it first — attaching to a node counts as much as attaching to a connector.
  const hasAnyAttachment =
    document.nodes.some((n) => n.attachments?.length) || document.edges.some((e) => e.attachments?.length);
  // At most one hint per connector: semantics first (the more central concept), the
  // drag-to-attach nudge only once semantics are out of the way — mirrors
  // `ElementInspectorPopover`'s own service-node/attachment-slot priority.
  const hintId: HintId | null = !hasExplicitSemantics
    ? 'connector-selected'
    : !hasAnyAttachment
      ? 'connector-attachment-slot'
      : null;
  const hintLearned = hintId === 'connector-selected' ? hasExplicitSemantics : hasAnyAttachment;

  return (
    <ViewportPortal>
      <div
        ref={panelRef}
        className="dc-edge-inspector"
        role="toolbar"
        aria-label="Connector options"
        data-closing={closing ? 'true' : undefined}
        style={{
          transform: flipBelow
            ? `translate(-50%, 0) translate(${labelFlowX}px, ${route.labelY + POPOVER_GAP}px)`
            : `translate(-50%, -100%) translate(${labelFlowX}px, ${route.labelY - POPOVER_GAP}px)`,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="dc-edge-inspector-inner">
          {hintId && <HintStrip id={hintId} learned={hintLearned} />}
          {/* Keyed on the edge id: the editor below is now always mounted (no more "⋯" to
              unmount it on collapse), so switching to a different connector must remount this
              subtree fresh — otherwise `ExpandedPanel`'s own local state (the colour palette,
              "show all behaviours") would leak from the previously-selected connector. */}
          <EdgeInspectorRow
            key={displayEdge.id}
            edge={displayEdge}
            sourceNode={sourceDraftNode}
            targetNode={targetDraftNode}
            membershipOpen={membershipOpen}
            setMembershipOpen={setMembershipOpen}
            theme={theme}
            store={store}
          />
        </div>
      </div>
    </ViewportPortal>
  );
}

function EdgeInspectorRow({
  edge,
  sourceNode,
  targetNode,
  membershipOpen,
  setMembershipOpen,
  theme,
  store,
}: {
  edge: DraftEdge;
  sourceNode: DraftNode | undefined;
  targetNode: DraftNode | undefined;
  membershipOpen: boolean;
  setMembershipOpen: (open: boolean) => void;
  theme: ReturnType<typeof useThemeValue>;
  store: typeof useEditorStore;
}) {
  const flows = useEditorStore((state) => state.document.flows);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const memberOf = flows.filter((flow) => stepIndexOf(flow, edge.id) !== undefined);
  const [editingLabel, setEditingLabel] = useState(false);

  const caption = edge.label || (edge.semantic ? SEMANTIC_DEFAULTS[edge.semantic].label : null);
  const flowChip = flowChipFor(flows, selectedFlowId, memberOf, edge.id);

  // A connector fanning *out* of a Junction is a branch — the branching structure itself already
  // communicates that ("approved"/"rejected", "yes"/"no"), so a contextual placeholder nudges
  // toward a branch label instead of the generic empty-connector copy, without requiring any
  // separate branch-type field (see `ExpandedPanel`'s own Junction handling).
  const sourceIsJunction = Boolean(sourceNode && categoryOf(sourceNode) === 'junction');
  const emptyLabelText = sourceIsJunction ? 'Add branch label…' : 'Add label…';

  return (
    <>
      <div className="dc-edge-inspector-row">
        {editingLabel ? (
          <input
            autoFocus
            className="dc-edge-inspector-caption-input"
            aria-label="Connector label"
            defaultValue={edge.label ?? ''}
            placeholder={edge.semantic ? SEMANTIC_DEFAULTS[edge.semantic].label : emptyLabelText}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => {
              store.getState().updateEdgeLabel(edge.id, event.currentTarget.value.trim());
              setEditingLabel(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setEditingLabel(false);
            }}
          />
        ) : (
          // Directly editable — no need to open anything just to rename a connector. See
          // `ExpandedPanel`'s own "Interaction" section for the semantic *type* picker, a
          // distinct concept this chip no longer doubles as a shortcut to.
          <button
            type="button"
            className="dc-edge-inspector-caption"
            data-empty={caption ? undefined : 'true'}
            title="Rename connector"
            onClick={() => setEditingLabel(true)}
          >
            {caption ?? emptyLabelText}
          </button>
        )}
        <button
          type="button"
          className="dc-edge-inspector-flows"
          data-empty={memberOf.length === 0 ? 'true' : undefined}
          data-flow-state={flowChip.state}
          title="Flow membership"
          onClick={() => {
            const state = store.getState();
            switch (flowChip.state) {
              case 'none':
                // No flows at all: one click starts one with this connector, and the panel
                // opens on its name — the same create-and-name motion as everywhere else.
                startFlowWithEdge(store, edge.id);
                return;
              case 'add':
                // The active flow is the context — one click, no picker.
                state.addEdgeToFlow(flowChip.flow.id, edge.id);
                return;
              default:
                setMembershipOpen(!membershipOpen);
            }
          }}
        >
          {flowChip.label}
        </button>
      </div>

      {membershipOpen && <MembershipPanel edgeId={edge.id} store={store} />}
      <ExpandedPanel edge={edge} sourceNode={sourceNode} targetNode={targetNode} theme={theme} store={store} />
    </>
  );
}

/**
 * What the connector's flow chip says and does, in order of how much the app already knows.
 * `none`: no flows exist — clicking starts one with this connector. `add`: there is an active
 * flow and this connector isn't in it — clicking appends it, one click, no picker; the active
 * flow *is* the context, so "Add to Checkout" is the honest label. Otherwise (`list`) the chip
 * names where the connector already is, with its step number, and clicking opens the checklist
 * for the less common moves: joining another flow, leaving one, starting a second.
 */
function flowChipFor(
  flows: DraftFlow[],
  selectedFlowId: string | null,
  memberOf: DraftFlow[],
  edgeId: string,
): { state: 'none'; label: string } | { state: 'add'; label: string; flow: DraftFlow } | { state: 'list'; label: string } {
  if (flows.length === 0) return { state: 'none', label: 'Add to flow' };
  const active = selectedFlowId ? flows.find((flow) => flow.id === selectedFlowId) : undefined;
  if (memberOf.length === 0) {
    return active ? { state: 'add', label: `Add to ${active.title}`, flow: active } : { state: 'list', label: 'Add to flow' };
  }
  // Lead with the active flow when the connector is in it; otherwise the first flow it's in.
  const lead = (active && memberOf.includes(active) ? active : memberOf[0])!;
  const others = memberOf.length - 1;
  return { state: 'list', label: `${lead.title} · ${stepIndexOf(lead, edgeId)}${others > 0 ? ` +${others}` : ''}` };
}

/** Starts a new flow with this connector as its first step, makes it the active flow, and hands
 *  it to the Flows panel to be named — the same create-and-name motion the panel and palette use. */
function startFlowWithEdge(store: typeof useEditorStore, edgeId: string) {
  const state = store.getState();
  const flowId = state.createFlow();
  if (!flowId) return;
  state.addEdgeToFlow(flowId, edgeId);
  state.setSelectedFlowId(flowId);
  const ui = useUiStore.getState();
  ui.setFlowPanelOpen(true);
  ui.requestFlowRename(flowId);
}

/**
 * One checkbox per flow — checked means this connector is a step of it, and the row says which
 * step. Toggling is immediate and reversible, no separate commit step. Deliberately does not
 * expose rename or step reordering here — that is the Flows panel's job; a membership checklist
 * is not the place for it.
 */
function MembershipPanel({ edgeId, store }: { edgeId: string; store: typeof useEditorStore }) {
  const flows = useEditorStore((state) => state.document.flows);

  return (
    // `dc-edge-inspector-membership` (alongside the shared `dc-edge-inspector-panel` box style)
    // is a bare selector hook — `ExpandedPanel`'s own box now permanently shares the same base
    // class, so tests/tools that need *this* panel specifically need a distinguishing one.
    <div className="dc-edge-inspector-panel dc-edge-inspector-membership">
      <ul className="dc-edge-inspector-membership-list">
        {flows.map((flow) => {
          const step = flow.steps.find((s) => s.edgeId === edgeId || s.extraEdgeIds?.includes(edgeId));
          const position = stepIndexOf(flow, edgeId);
          return (
            <li key={flow.id}>
              <label className="dc-edge-inspector-membership-row">
                <input
                  type="checkbox"
                  checked={step !== undefined}
                  onChange={() => {
                    const state = store.getState();
                    if (step) {
                      // Leaving a step it merely spotlights must not delete the step itself.
                      if (step.edgeId === edgeId) state.removeFlowStep(flow.id, step.id);
                      else state.removeFlowStepExtraEdge(flow.id, step.id, edgeId);
                    } else {
                      state.addEdgeToFlow(flow.id, edgeId);
                      // Immediate visual feedback: this flow's lens lights up right away.
                      state.setSelectedFlowId(flow.id);
                    }
                  }}
                />
                <span className="dc-edge-inspector-membership-title">{flow.title}</span>
                {position !== undefined && (
                  <span className="dc-edge-inspector-membership-step">step {position}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      <Button variant="quiet" onClick={() => startFlowWithEdge(store, edgeId)}>
        + New flow
      </Button>
    </div>
  );
}

/** A queue relationship's behaviour reads as an event carried asynchronously
 *  — spelling both out is more legible in a compact badge than the bare
 *  `ConnectorKind` label. Kept in sync with `Inspector.tsx`'s copy of the
 *  same helper — see that file's `behaviorBadgeLabel` for the original. */
function behaviorBadgeLabel(kind: ConnectorKind): string {
  return kind === 'event' ? 'Event · Async' : CONNECTOR_KIND_LABELS[kind];
}

const SUCCESS_STATUS_BY_VERB: Record<string, string> = {
  GET: '200',
  POST: '201',
  PUT: '200',
  PATCH: '200',
  DELETE: '204',
};

/** Best-effort "Success" default for a request/response connector, derived from the request's own
 *  label — e.g. "GET Customer" → "200 Customer", "POST Payment" → "201 Payment". Falls back to a
 *  bare "200" (or "200 <label>" for a label with no recognisable verb) when nothing more specific
 *  can be inferred; the user is always free to overwrite it afterward. */
function inferSuccessResponse(label: string | undefined): string {
  const trimmed = label?.trim();
  if (!trimmed) return '200';
  const [first, ...rest] = trimmed.split(/\s+/);
  const verb = first!.toUpperCase();
  const status = SUCCESS_STATUS_BY_VERB[verb];
  if (!status) return `200 ${trimmed}`;
  const resource = rest.join(' ').trim();
  return resource ? `${status} ${resource}` : status;
}

/**
 * A small two-field editor for a "verb + subject"-shaped string (a request label like "GET
 * Customer", a response like "200 Customer") — splits purely for display/editing convenience,
 * never persisted as two values: both fields commit back to the same single string field
 * (`edge.label`/`edge.response`) the rest of the app already reads. `key`-remounted by the
 * caller whenever that string changes from elsewhere (e.g. the "Guess" button, undo/redo) since
 * these inputs are intentionally uncontrolled — see `dc-input-response`'s own precedent.
 */
function SplitTextEditor({
  value,
  onCommit,
  firstPlaceholder,
  restPlaceholder,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  firstPlaceholder: string;
  restPlaceholder: string;
  ariaLabel: string;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const restRef = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();
  const spaceIndex = trimmed.indexOf(' ');
  const initialFirst = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const initialRest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

  const commit = () => {
    const first = firstRef.current?.value.trim() ?? '';
    const rest = restRef.current?.value.trim() ?? '';
    onCommit([first, rest].filter(Boolean).join(' '));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') event.currentTarget.blur();
  };

  return (
    <div className="dc-inspector-split" aria-label={ariaLabel}>
      <input
        ref={firstRef}
        className="dc-inspector-control dc-inspector-split-first"
        defaultValue={initialFirst}
        placeholder={firstPlaceholder}
        spellCheck={false}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <input
        ref={restRef}
        className="dc-inspector-control dc-inspector-split-rest"
        defaultValue={initialRest}
        placeholder={restPlaceholder}
        spellCheck={false}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** A single free-text field for a request/response value with no "verb + subject" shape to
 *  split — Generic Call's Request/Response, which (unlike HTTP) has no fixed vocabulary to
 *  decompose into two boxes. `key`-remounted by the caller on external changes, same discipline
 *  as `SplitTextEditor`'s own inputs. */
function SingleTextEditor({
  value,
  onCommit,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <input
      className="dc-inspector-control"
      aria-label={ariaLabel}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(event) => onCommit(event.currentTarget.value.trim())}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Like `SplitTextEditor`, but the first field is a fixed-vocabulary `InspectorSelect` (HTTP
 * verbs) instead of free text — used only for a Service→Service Request in HTTP mode. Commits
 * to the same single string field `SplitTextEditor` does (`"METHOD resource"`, e.g. "GET
 * Customers"); switching protocols back to Generic Call just changes how this one string is
 * *edited*, never its shape.
 */
function HttpRequestEditor({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const restRef = useRef<HTMLInputElement>(null);
  const trimmed = value.trim();
  const spaceIndex = trimmed.indexOf(' ');
  const rawMethod = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toUpperCase();
  const initialRest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const method = rawMethod || 'GET';

  // A pre-existing label whose first word isn't a real HTTP verb (free text written before
  // switching into HTTP mode) stays selectable rather than silently discarded — the same
  // "never clobber an unusual existing value" principle `ServiceInteractionSection`'s own
  // Protocol/Mode selects follow.
  const isKnownMethod = (HTTP_METHODS as readonly string[]).includes(method);
  const methodOptions: InspectorSelectOption[] = [
    ...(isKnownMethod ? [] : [{ value: method, label: method }]),
    ...HTTP_METHODS.map((m) => ({ value: m, label: m })),
  ];

  const commit = (nextMethod: string, rest: string) => onCommit([nextMethod, rest].filter(Boolean).join(' '));

  return (
    <div className="dc-inspector-split" aria-label="Request">
      <InspectorSelect
        className="dc-inspector-select-split-first"
        value={method}
        options={methodOptions}
        ariaLabel="Request method"
        onChange={(nextMethod) => commit(nextMethod, restRef.current?.value.trim() ?? initialRest)}
      />
      <input
        ref={restRef}
        className="dc-inspector-control dc-inspector-split-rest"
        defaultValue={initialRest}
        placeholder="Customers"
        spellCheck={false}
        onBlur={(event) => commit(method, event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </div>
  );
}

const SERVICE_PROTOCOL_OPTIONS: InspectorSelectOption[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'calls', label: 'Generic Call' },
];

const SERVICE_MODE_OPTIONS: InspectorSelectOption[] = [
  { value: 'sync', label: 'Sync' },
  { value: 'async', label: 'Async' },
];

/**
 * The opinionated Service→Service editor — replaces the generic Interaction section (the full
 * `EdgeSemantic`/`ConnectorKind` vocabulary: Event, Publishes, Reads, Retry, Fallback, …) with
 * just the handful of concepts that actually apply to two services talking to each other: HTTP
 * or a Generic Call, Sync or Async. Gated by `defaultsToResponse` at the call site below — every
 * other pairing (Queue, Database, Actor, generic shapes) keeps the generic section untouched.
 *
 * Sync/Async is deliberately *not* wired through `setEdgeKind` — that action's `kind: 'async'`
 * → `edge.async: true` side effect (see its own comment in `editorStore.ts`) is exactly right
 * for the generic kind picker, where "async" and "dashed line" are meant to read as one thing,
 * but wrong here: a request line's solid/dashed styling is a Style concern, not what Sync/Async
 * means for a service call. This section updates `kind` directly via `updateEdgeById` instead,
 * so the primary line never dashes just because Async was chosen.
 */
function ServiceInteractionSection({ edge, store }: { edge: DraftEdge; store: typeof useEditorStore }) {
  // Generic Call ('calls') is the fallback reading for anything outside {http, calls} too —
  // including an edge that predates this editor and was left on some other `EdgeSemantic`.
  const protocol = edge.semantic === 'http' ? 'http' : 'calls';
  const protocolOptions: InspectorSelectOption[] =
    edge.semantic === undefined || edge.semantic === 'http' || edge.semantic === 'calls'
      ? SERVICE_PROTOCOL_OPTIONS
      : [...SERVICE_PROTOCOL_OPTIONS, { value: edge.semantic, label: EDGE_SEMANTIC_LABELS[edge.semantic] }];

  const isAsync = edge.kind === 'async';
  const modeOptions: InspectorSelectOption[] =
    edge.kind === undefined || edge.kind === 'sync' || edge.kind === 'async'
      ? SERVICE_MODE_OPTIONS
      : [...SERVICE_MODE_OPTIONS, { value: edge.kind, label: CONNECTOR_KIND_LABELS[edge.kind] }];

  const isHttp = protocol === 'http';

  return (
    <>
      <section className="dc-inspector-section">
        <span className="dc-inspector-section-label">Interaction</span>
        <div className="dc-inspector-section-row">
          <InspectorSelect
            value={edge.semantic ?? 'calls'}
            options={protocolOptions}
            ariaLabel="Protocol"
            // Deliberately not `setEdgeSemantic` — that action's "fill in the blank" convenience
            // (auto-labelling an unlabelled edge with the semantic's own default text, e.g.
            // "HTTP") is right for the generic vocabulary but wrong here: Protocol and Request
            // are independent fields in this editor, and choosing a protocol must never
            // overwrite the Request text underneath it.
            onChange={(value) =>
              store
                .getState()
                .updateEdgeById(edge.id, { semantic: value as EdgeSemantic, semanticsOrigin: 'explicit' }, 'Set protocol')
            }
          />
          <InspectorSelect
            value={edge.kind ?? 'sync'}
            options={modeOptions}
            ariaLabel="Interaction mode"
            onChange={(value) => {
              const nowAsync = value === 'async';
              store.getState().updateEdgeById(
                edge.id,
                {
                  kind: nowAsync ? 'async' : undefined,
                  // An async interaction doesn't pretend to share a synchronous response —
                  // turning the line's own response off (never `edge.response`'s text: the
                  // user's typed value survives, ready the moment they switch back to Sync).
                  hasResponse: nowAsync ? undefined : edge.hasResponse,
                  semanticsOrigin: 'explicit',
                },
                'Set interaction mode',
              );
            }}
          />
        </div>
      </section>

      <section className="dc-inspector-section">
        <span className="dc-inspector-section-label">Request</span>
        {isHttp ? (
          <HttpRequestEditor
            key={edge.label ?? ''}
            value={edge.label ?? ''}
            onCommit={(next) => store.getState().updateEdgeLabel(edge.id, next)}
          />
        ) : (
          // Wrapped in the same `.dc-inspector-section-row` every other single-control row in
          // this panel uses (Response's own Generic Call field included) — `.dc-inspector-control`'s
          // `flex: 1` assumes a *row* flex context to size its width; as a bare child of this
          // section's own *column* flex container, `flex: 1` instead governs the column's main
          // (vertical) axis, collapsing the input's height down to its content minimum instead of
          // the intended 32px.
          <div className="dc-inspector-section-row">
            <SingleTextEditor
              key={edge.label ?? ''}
              value={edge.label ?? ''}
              placeholder="Validate customer"
              ariaLabel="Request"
              onCommit={(next) => store.getState().updateEdgeLabel(edge.id, next)}
            />
          </div>
        )}
      </section>

      {!isAsync && (
        <section className="dc-inspector-section">
          <div className="dc-inspector-section-header">
            <span className="dc-inspector-section-label">Response</span>
            <button
              type="button"
              className="dc-inspector-toggle"
              data-active={edge.hasResponse ? 'true' : undefined}
              aria-pressed={Boolean(edge.hasResponse)}
              title="Draw a quieter reply line back to the caller"
              onClick={() => store.getState().setEdgeHasResponse(edge.id, !edge.hasResponse)}
            >
              {edge.hasResponse ? 'On' : 'Off'}
            </button>
          </div>
          {edge.hasResponse && (
            <div className="dc-inspector-section-row">
              {isHttp ? (
                <SplitTextEditor
                  key={edge.response ?? ''}
                  ariaLabel="Response"
                  value={edge.response ?? ''}
                  firstPlaceholder="200"
                  restPlaceholder="Customers"
                  onCommit={(next) => store.getState().setEdgeResponse(edge.id, next)}
                />
              ) : (
                <SingleTextEditor
                  key={edge.response ?? ''}
                  value={edge.response ?? ''}
                  placeholder="OK"
                  ariaLabel="Response"
                  onCommit={(next) => store.getState().setEdgeResponse(edge.id, next)}
                />
              )}
              {isHttp && !edge.response && (
                <button
                  type="button"
                  className="dc-inspector-hint"
                  title="Guess a response from the request's own verb"
                  onClick={() => store.getState().setEdgeResponse(edge.id, inferSuccessResponse(edge.label))}
                >
                  Guess
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

/**
 * The "is this pairing itself unusual" nudge — see `connectorSemantics.ts`'s `RelationshipStatus`/
 * `quickFixesFor`. Renders nothing for the ordinary case (a `'valid'` pairing whose edge already
 * picked something `capability.relations` recognizes) — this is a subtle, occasional aside, not a
 * standing panel. `capability.guidance` covers "this pairing itself is unusual" (e.g. Queue →
 * Topic, Gateway → any storage kind) and is shown on its own whenever the matrix sets it, whether
 * or not a `quickFix` exists — a static "this is unusual" opinion doesn't need a one-click
 * resolution to be worth surfacing (Gateway → storage has no clean graph transform to offer, so it
 * has guidance with no fix). The fallback message covers the narrower case of an edge whose *own*
 * explicit `semantic` no longer fits its (possibly re-pointed) endpoints even though the pairing
 * itself is ordinary — see the spec's "Service → Database 'writes' re-pointed to a Topic" example.
 * Never both messages at once: one quiet line is the point.
 */
function RelationshipGuidance({
  edge,
  capability,
  store,
}: {
  edge: DraftEdge;
  capability: ConnectionCapability | undefined;
  store: typeof useEditorStore;
}) {
  const fixes = quickFixesFor(capability, edge);
  const retarget = fixes.find((fix) => fix.id === 'retarget-relation');
  const message =
    capability?.guidance ??
    (retarget && edge.semantic
      ? `"${EDGE_SEMANTIC_LABELS[edge.semantic]}" doesn't typically apply to this connection.`
      : undefined);
  if (!message) return null;

  return (
    <div className="dc-relationship-guidance">
      <span className="dc-relationship-guidance-text">{message}</span>
      {fixes.length > 0 && (
        <div className="dc-relationship-guidance-actions">
          {fixes.map((fix) => (
            <button
              key={fix.id}
              type="button"
              className="dc-relationship-guidance-fix"
              onClick={() =>
                fix.id === 'insert-worker'
                  ? store.getState().insertWorkerOnEdge(edge.id)
                  : store.getState().setEdgeSemantic(edge.id, fix.semantic)
              }
            >
              {fix.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The connector's contextual editor — shown immediately under the compact row for every selected
 * connector, no click required (see this file's own top comment) — grouped into labelled sections
 * rather than one flat control grid. Only the sections/fields relevant to *this* connector render:
 * a generic connector never sees Request/Response, a predetermined-behaviour pairing never sees a
 * bare "no kind" picker, the Interaction type list itself narrows to what the pairing actually
 * supports (falling back to the full vocabulary for an unclassified/generic pairing with no
 * capability-matrix entry), and so on.
 */
function ExpandedPanel({
  edge,
  sourceNode,
  targetNode,
  theme,
  store,
}: {
  edge: DraftEdge;
  sourceNode: DraftNode | undefined;
  targetNode: DraftNode | undefined;
  theme: ReturnType<typeof useThemeValue>;
  store: typeof useEditorStore;
}) {
  const [editingBehavior, setEditingBehavior] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // A Junction is a routing/convergence point, not a system component of its own — it has no
  // semantic identity, so every capability lookup below resolves *through* it to whatever it
  // actually connects (`resolveTransparentCategory`) rather than stopping at the Junction and
  // treating the connector as generic. A Junction still isn't a component itself, though: its own
  // branch label (`sourceIsJunction` above) is what matters on the way out of one, so the
  // free-text Condition field — a separate, narrower field — stays hidden whenever either end is
  // a Junction. This never strips an already-persisted `condition` from an older document, it
  // only stops offering the control that would edit it.
  const nodes = useEditorStore((state) => state.document.nodes);
  const edges = useEditorStore((state) => state.document.edges);
  const graph = { nodes, edges };
  const touchesJunction =
    (sourceNode && categoryOf(sourceNode) === 'junction') || (targetNode && categoryOf(targetNode) === 'junction');

  const resolvedSourceCategory = sourceNode ? resolveTransparentCategory(graph, sourceNode.id, 'source') : undefined;
  const resolvedTargetCategory = targetNode ? resolveTransparentCategory(graph, targetNode.id, 'target') : undefined;

  const capability: ConnectionCapability | undefined =
    resolvedSourceCategory && resolvedTargetCategory
      ? capabilityFor(resolvedSourceCategory, resolvedTargetCategory)
      : undefined;

  const behaviorIsPredetermined = Boolean(capability) && capability!.behaviors.length === 0;
  const behaviorMatchesPolicy = !edge.kind || edge.kind === capability?.defaultBehavior;
  const showBehaviorPicker = !behaviorIsPredetermined || !behaviorMatchesPolicy || editingBehavior;
  const behaviorBase = capability && capability.behaviors.length > 0 ? capability.behaviors : CONNECTOR_KINDS;
  const hideSyncOption = behaviorBase.includes('sync') && edge.kind !== 'sync';
  const behaviorOptions = hideSyncOption ? behaviorBase.filter((kind) => kind !== 'sync') : behaviorBase;
  // A Junction connector never gets the free-text Condition field either — see
  // `touchesJunction`'s own comment above: the connector's label is the one field that matters
  // here, whether that's a plain optional label or a branch name.
  const showCondition = !touchesJunction && (showBehaviorPicker || Boolean(edge.condition));

  // Only offered where a connector already reads as an unambiguous synchronous call — see
  // `isSyncPairing`'s own doc comment for exactly which pairings that covers and why. A connector
  // that already carries a response never loses the section just because the pairing or kind
  // changed underneath it, same discipline as `showCondition` above.
  const canHaveResponse =
    Boolean(resolvedSourceCategory && resolvedTargetCategory) &&
    isSyncPairing(resolvedSourceCategory!, resolvedTargetCategory!) &&
    (edge.kind === undefined || edge.kind === 'sync');
  const showRequestResponse = canHaveResponse || Boolean(edge.hasResponse);

  // The opinionated editor (`ServiceInteractionSection`) replaces the generic Interaction
  // section below for exactly the pairing `defaultsToResponse` already means "two services
  // talking to each other" for (see its own doc comment) — everything else, Actor→Service
  // included, keeps the generic, unrestricted vocabulary exactly as it reads today. A Junction
  // resolving transparently to a service on both sides (e.g. Service → Junction → Service) reads
  // the same way, reusing this same editor rather than inventing a Junction-specific one.
  const isServiceToService =
    Boolean(resolvedSourceCategory && resolvedTargetCategory) &&
    defaultsToResponse(resolvedSourceCategory!, resolvedTargetCategory!);

  const currentAccentChip = edge.accent !== undefined ? theme.accents[edge.accent].chip : undefined;

  // Narrowed to what this pairing actually supports (`capability.relations`, already in display
  // order) instead of the full `EdgeSemantic` vocabulary — Service→Queue sees only
  // Publishes/Event/Depends on, Queue→Service only Consumes/Event/Depends on, and so on. A
  // pairing with no capability-matrix entry at all (generic/unclassified shapes) keeps the full
  // list, exactly as before. Same "never clobber an unusual existing value" principle
  // `ServiceInteractionSection`'s own Protocol/Mode selects already follow: a pre-existing
  // `edge.semantic` outside the narrowed set stays selectable as an extra option.
  const relationOptions: InspectorSelectOption[] = capability
    ? [
        { value: '', label: 'No type' },
        ...capability.relations.map((semantic) => ({ value: semantic, label: EDGE_SEMANTIC_LABELS[semantic] })),
        ...(edge.semantic && !capability.relations.includes(edge.semantic)
          ? [{ value: edge.semantic, label: EDGE_SEMANTIC_LABELS[edge.semantic] }]
          : []),
      ]
    : [
        { value: '', label: 'No type' },
        ...EDGE_SEMANTICS.map((semantic) => ({ value: semantic, label: EDGE_SEMANTIC_LABELS[semantic] })),
      ];

  const routingOptions: InspectorSelectOption[] = [
    { value: 'smoothstep', label: 'Stepped' },
    { value: 'bezier', label: 'Curved' },
    { value: 'straight', label: 'Straight' },
  ];

  return (
    <div className="dc-edge-inspector-panel dc-edge-inspector-expanded">
      <RelationshipGuidance edge={edge} capability={capability} store={store} />
      {isServiceToService ? (
        <ServiceInteractionSection edge={edge} store={store} />
      ) : (
        <>
          <section className="dc-inspector-section">
            <span className="dc-inspector-section-label">Interaction</span>
            <div className="dc-inspector-section-row">
              <InspectorSelect
                value={edge.semantic ?? ''}
                ariaLabel="Interaction type"
                options={relationOptions}
                onChange={(value) =>
                  store.getState().setEdgeSemantic(edge.id, (value || undefined) as EdgeSemantic | undefined)
                }
              />
              {showBehaviorPicker ? (
                <InspectorSelect
                  value={edge.kind ?? ''}
                  ariaLabel="Flow kind"
                  options={[
                    { value: '', label: capability?.behaviors.includes('sync') ? 'Sync' : 'No kind' },
                    ...behaviorOptions.map((kind) => ({ value: kind, label: CONNECTOR_KIND_LABELS[kind] })),
                  ]}
                  onChange={(value) =>
                    store.getState().setEdgeKind(edge.id, (value || undefined) as ConnectorKind | undefined)
                  }
                />
              ) : (
                capability?.defaultBehavior && (
                  <button
                    type="button"
                    className="dc-inspector-badge"
                    title="Inferred from what this connects — click to change"
                    onClick={() => setEditingBehavior(true)}
                  >
                    {behaviorBadgeLabel(capability.defaultBehavior)}
                  </button>
                )
              )}
            </div>
          </section>

          {showRequestResponse && (
            <>
              <section className="dc-inspector-section">
                <span className="dc-inspector-section-label">Request</span>
                <SplitTextEditor
                  key={edge.label ?? ''}
                  ariaLabel="Request"
                  value={edge.label ?? ''}
                  firstPlaceholder="GET"
                  restPlaceholder="Customer"
                  onCommit={(next) => store.getState().updateEdgeLabel(edge.id, next)}
                />
              </section>

              <section className="dc-inspector-section">
                <div className="dc-inspector-section-header">
                  <span className="dc-inspector-section-label">Response</span>
                  <button
                    type="button"
                    className="dc-inspector-toggle"
                    data-active={edge.hasResponse ? 'true' : undefined}
                    aria-pressed={Boolean(edge.hasResponse)}
                    title="Draw a quieter reply line back to the caller"
                    onClick={() => store.getState().setEdgeHasResponse(edge.id, !edge.hasResponse)}
                  >
                    {edge.hasResponse ? 'On' : 'Off'}
                  </button>
                </div>
                {edge.hasResponse && (
                  <div className="dc-inspector-section-row">
                    <SplitTextEditor
                      key={edge.response ?? ''}
                      ariaLabel="Response"
                      value={edge.response ?? ''}
                      firstPlaceholder="200"
                      restPlaceholder="Customer"
                      onCommit={(next) => store.getState().setEdgeResponse(edge.id, next)}
                    />
                    {!edge.response && (
                      <button
                        type="button"
                        className="dc-inspector-hint"
                        title="Guess a response from the request's own verb"
                        onClick={() => store.getState().setEdgeResponse(edge.id, inferSuccessResponse(edge.label))}
                      >
                        Guess
                      </button>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {edge.semantic === 'deadLetters' && (
        <section className="dc-inspector-section">
          <span className="dc-inspector-section-label">Delivery attempts</span>
          <div className="dc-inspector-section-row">
            <Button
              variant="ghost"
              aria-label="Decrease delivery attempts"
              onClick={() => store.getState().setEdgeDeliveryAttempts(edge.id, (edge.deliveryAttempts ?? 3) - 1)}
            >
              −
            </Button>
            <span>{edge.deliveryAttempts ?? 3}</span>
            <Button
              variant="ghost"
              aria-label="Increase delivery attempts"
              onClick={() => store.getState().setEdgeDeliveryAttempts(edge.id, (edge.deliveryAttempts ?? 3) + 1)}
            >
              +
            </Button>
          </div>
        </section>
      )}

      <section className="dc-inspector-section">
        <span className="dc-inspector-section-label">Route</span>
        <div className="dc-inspector-section-row">
          <InspectorSelect
            value={edge.routing}
            ariaLabel="Connector shape"
            options={routingOptions}
            onChange={(value) =>
              store
                .getState()
                .updateEdgeById(edge.id, { routing: value as typeof edge.routing }, 'Change routing')
            }
          />
        </div>
      </section>

      <section className="dc-inspector-section">
        <span className="dc-inspector-section-label">Style</span>
        <div className="dc-inspector-section-row">
          <Button
            variant="ghost"
            active={edge.directed}
            title="Show an arrowhead"
            onClick={() => store.getState().updateEdgeById(edge.id, { directed: !edge.directed }, 'Change direction')}
          >
            Arrow
          </Button>
          <button
            type="button"
            className="dc-inspector-color-swatch"
            data-auto={currentAccentChip ? undefined : 'true'}
            aria-label="Connector colour"
            title={currentAccentChip ? 'Change colour' : 'Auto colour — click to override'}
            style={currentAccentChip ? { background: currentAccentChip } : undefined}
            onClick={() => setPaletteOpen((v) => !v)}
          />
          {showCondition && (
            <input
              className="dc-inspector-control dc-inspector-condition"
              aria-label="Condition"
              placeholder="Condition…"
              defaultValue={edge.condition ?? ''}
              spellCheck={false}
              onBlur={(event) => store.getState().setEdgeCondition(edge.id, event.currentTarget.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          )}
        </div>
        {paletteOpen && (
          <div className="dc-inspector-section-row dc-swatches">
            {ACCENTS.map((accent) => (
              <button
                key={accent}
                type="button"
                className="dc-swatch"
                title={accent}
                aria-label={`Colour ${accent}`}
                style={{ background: theme.accents[accent].chip }}
                onClick={() => {
                  store.getState().updateEdgeById(edge.id, { accent }, 'Recolour');
                  setPaletteOpen(false);
                }}
              />
            ))}
            {edge.accent !== undefined && (
              <Button
                variant="ghost"
                title="Derive this connection's colour from its source node instead of a fixed one"
                onClick={() => {
                  store.getState().updateEdgeById(edge.id, { accent: undefined }, 'Reset colour');
                  setPaletteOpen(false);
                }}
              >
                Auto
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
