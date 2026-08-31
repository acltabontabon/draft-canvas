import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ViewportPortal, useInternalNode, useReactFlow } from '@xyflow/react';
import {
  ACCENTS,
  CONNECTOR_KINDS,
  EDGE_SEMANTICS,
  type ConnectorKind,
  type DraftEdge,
  type DraftNode,
  type EdgeSemantic,
} from '../document/types';
import { stepIndexOf } from '../document/flow';
import { capabilityFor, categoryOf, isSyncPairing, type ConnectionCapability } from '../document/connectorSemantics';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import { routeBetween } from '../edges/routing';
import { useEditorStore } from '../store/editorStore';
import { edgeIndex, nodeIndex } from '../store/selectors';
import { useThemeValue } from '../ui/theme/useTheme';
import { Button } from '../ui/common/Button';
import { attachmentRowBelowsSourceOrTarget, rectOfInternal } from './edgeGeometry';

const EDGE_SEMANTIC_LABELS: Record<EdgeSemantic, string> = {
  http: 'HTTP',
  event: 'Event',
  command: 'Command',
  query: 'Query',
  reads: 'Reads',
  writes: 'Writes',
  publishes: 'Publishes',
  consumes: 'Consumes',
  calls: 'Calls',
  dependsOn: 'Depends on',
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

type PanelKind = 'membership' | 'expanded';

/**
 * The contextual control for a single selected connector — anchored at its
 * own label point instead of docked at the bottom of the screen (the thing
 * `Inspector.tsx`'s old `EdgeControls`/`EdgeFlowMembership` did). Mounted
 * only while exactly one edge, and no node, is selected; `Inspector` itself
 * no longer renders anything for that case, so this is the only edge UI a
 * single-connector selection shows.
 *
 * The compact row (label chip, flow chip, `⋯`) is the entire UI for the common case — renaming,
 * flow membership, and a glance at what this connector is. `⋯` is the one door to everything
 * else (interaction type, request/response, routing, style), grouped into labelled sections
 * rather than one flat control grid; `+ Flow` opens its own small checklist. At most one of the
 * two expands at a time, mirroring the one-thing-open-at-once discipline `EdgeAttachmentChip`
 * already uses for attachment cards.
 */
export function EdgeInspectorPopover() {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const store = useEditorStore;
  const theme = useThemeValue();
  const { flowToScreenPosition } = useReactFlow();

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
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // A real measurement, not a guess: which side to sit on (see the `flipBelow` calculation
  // below) depends on the popover's own height, and that varies a lot between the compact row
  // and the expanded editor's several sections. Re-measures after every render — cheap (one
  // `getBoundingClientRect` read) and guarded so it only ever triggers a re-render when the
  // height actually changed, converging in at most one extra frame whenever content changes.
  const [measuredHeight, setMeasuredHeight] = useState(0);
  // Deliberately no dependency array — this must re-measure after every render (content height
  // can change for reasons with no single dependency to name: a new section appearing, a
  // multi-line label). The `height !== measuredHeight` guard is what keeps this from looping.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const height = panelRef.current?.getBoundingClientRect().height ?? 0;
    if (height > 0 && height !== measuredHeight) setMeasuredHeight(height);
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

  // Selecting a *different* connector while a sub-panel is open must close
  // it — otherwise it keeps showing the connector it was opened for. This is
  // not covered by the `open`-keyed effect below: clicking straight from one
  // edge to another never makes `open` itself go false, since a new edge is
  // selected in the same tick the old one is deselected.
  useEffect(() => {
    setPanel(null);
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
    setPanel(null);
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

  // Escape closes an open sub-panel first, without touching the selection —
  // the global Escape handler still clears selection on a second press.
  // Click-away closes the sub-panel the same way, but never deselects.
  useEffect(() => {
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPanel(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setPanel(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [panel]);

  if (!mounted) return null;
  const displayEdge = open ? edge : lastEdgeRef.current;
  const displaySource = open ? sourceInternal : lastSourceRef.current;
  const displayTarget = open ? targetInternal : lastTargetRef.current;
  if (!displayEdge || !displaySource || !displayTarget) return null;

  const sourceRect = rectOfInternal(displaySource);
  const targetRect = rectOfInternal(displayTarget);
  if (!sourceRect || !targetRect) return null;

  const route = routeBetween(sourceRect, targetRect, displayEdge.routing, {
    anchors: { source: displayEdge.sourceAnchor, target: displayEdge.targetAnchor },
  });
  // Two independent reasons to prefer sitting below the connector instead of above it: the
  // node-overlap heuristic every popover/attachment row already shares (a short connector whose
  // label point sits close to its own source/target), and — new here, since the expanded editor
  // is tall enough to matter — not enough screen room above the label point before the toolbar.
  // `measuredHeight` starts at 0 (nothing measured yet, e.g. the very first frame after
  // selecting an edge), which always reads as "enough room" — a brief default that self-corrects
  // one frame later once `useLayoutEffect` reports the real height, never a lasting wrong guess.
  const screenLabelPoint = flowToScreenPosition({ x: route.labelX, y: route.labelY });
  const notEnoughRoomAbove = screenLabelPoint.y - POPOVER_GAP - measuredHeight < TOOLBAR_CLEARANCE;
  const flipBelow =
    attachmentRowBelowsSourceOrTarget(route.labelX, route.labelY, sourceRect, targetRect) || notEnoughRoomAbove;

  const sourceDraftNode = nodeIndex(document.nodes).get(displayEdge.source);
  const targetDraftNode = nodeIndex(document.nodes).get(displayEdge.target);

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
            ? `translate(-50%, 0) translate(${route.labelX}px, ${route.labelY + POPOVER_GAP}px)`
            : `translate(-50%, -100%) translate(${route.labelX}px, ${route.labelY - POPOVER_GAP}px)`,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="dc-edge-inspector-inner">
          <EdgeInspectorRow
            edge={displayEdge}
            sourceNode={sourceDraftNode}
            targetNode={targetDraftNode}
            panel={panel}
            setPanel={setPanel}
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
  panel,
  setPanel,
  theme,
  store,
}: {
  edge: DraftEdge;
  sourceNode: DraftNode | undefined;
  targetNode: DraftNode | undefined;
  panel: PanelKind | null;
  setPanel: (panel: PanelKind | null) => void;
  theme: ReturnType<typeof useThemeValue>;
  store: typeof useEditorStore;
}) {
  const flows = useEditorStore((state) => state.document.flows);
  const memberOf = flows.filter((flow) => stepIndexOf(flow, edge.id) !== undefined);
  const [editingLabel, setEditingLabel] = useState(false);

  const caption = edge.label || (edge.semantic ? SEMANTIC_DEFAULTS[edge.semantic].label : null);
  const flowChipLabel =
    memberOf.length === 0
      ? 'Add to flow'
      : memberOf.length === 1
        ? memberOf[0]!.title
        : `${memberOf[0]!.title} +${memberOf.length - 1}`;

  const toggle = (next: PanelKind) => setPanel(panel === next ? null : next);

  return (
    <>
      <div className="dc-edge-inspector-row">
        {editingLabel ? (
          <input
            autoFocus
            className="dc-edge-inspector-caption-input"
            aria-label="Connector label"
            defaultValue={edge.label ?? ''}
            placeholder={edge.semantic ? SEMANTIC_DEFAULTS[edge.semantic].label : 'Label…'}
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
          // Directly editable — no need to open the full editor just to rename a connector.
          // See `ExpandedPanel`'s own "Interaction" section for the semantic *type* picker,
          // a distinct concept this chip no longer doubles as a shortcut to.
          <button
            type="button"
            className="dc-edge-inspector-caption"
            data-empty={caption ? undefined : 'true'}
            title="Rename connector"
            onClick={() => setEditingLabel(true)}
          >
            {caption ?? 'Add label…'}
          </button>
        )}
        <button
          type="button"
          className="dc-edge-inspector-flows"
          data-empty={memberOf.length === 0 ? 'true' : undefined}
          title="Flow membership"
          onClick={() => toggle('membership')}
        >
          {flowChipLabel}
        </button>
        <Button
          variant="quiet"
          aria-label="More connector options"
          title="More options"
          active={panel === 'expanded'}
          onClick={() => toggle('expanded')}
        >
          ⋯
        </Button>
      </div>

      {panel === 'membership' && <MembershipPanel edgeId={edge.id} store={store} />}
      {panel === 'expanded' && (
        <ExpandedPanel edge={edge} sourceNode={sourceNode} targetNode={targetNode} theme={theme} store={store} />
      )}
    </>
  );
}

/**
 * One checkbox per flow — checked means this connector is a step of it.
 * Toggling is immediate and reversible, no separate commit step (spec: "make
 * joining/leaving flows obvious and reversible"). Deliberately does not
 * expose rename or step reordering here — that stays in `FlowPanel`'s deep
 * editing surface; a membership checklist is not the place for it.
 */
function MembershipPanel({ edgeId, store }: { edgeId: string; store: typeof useEditorStore }) {
  const flows = useEditorStore((state) => state.document.flows);

  return (
    <div className="dc-edge-inspector-panel">
      <ul className="dc-edge-inspector-membership-list">
        {flows.map((flow) => {
          const stepId = flow.steps.find(
            (step) => step.edgeId === edgeId || step.extraEdgeIds?.includes(edgeId),
          )?.id;
          const member = stepId !== undefined;
          return (
            <li key={flow.id}>
              <label className="dc-edge-inspector-membership-row">
                <input
                  type="checkbox"
                  checked={member}
                  onChange={() => {
                    const state = store.getState();
                    if (member && stepId) {
                      state.removeFlowStep(flow.id, stepId);
                    } else {
                      state.addEdgeToFlow(flow.id, edgeId);
                      // Immediate visual feedback: this flow's lens lights up right away.
                      state.setSelectedFlowId(flow.id);
                    }
                  }}
                />
                {flow.title}
              </label>
            </li>
          );
        })}
      </ul>
      <Button
        variant="quiet"
        onClick={() => {
          const state = store.getState();
          const flowId = state.createFlow();
          state.addEdgeToFlow(flowId, edgeId);
          state.setSelectedFlowId(flowId);
        }}
      >
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

/**
 * Everything beyond the compact row, grouped into labelled sections rather than one flat control
 * grid — see this file's own top comment. Only the sections/fields relevant to *this* connector
 * render: a generic connector never sees Request/Response, a predetermined-behaviour pairing
 * never sees a bare "no kind" picker, and so on — the same conditions `AdvancedPanel` (this
 * component's predecessor) already computed, just composed into readable groups instead of a
 * single wrapped row.
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

  const capability: ConnectionCapability | undefined =
    sourceNode && targetNode ? capabilityFor(categoryOf(sourceNode), categoryOf(targetNode)) : undefined;

  const behaviorIsPredetermined = Boolean(capability) && capability!.behaviors.length === 0;
  const behaviorMatchesPolicy = !edge.kind || edge.kind === capability?.defaultBehavior;
  const showBehaviorPicker = !behaviorIsPredetermined || !behaviorMatchesPolicy || editingBehavior;
  const behaviorBase = capability && capability.behaviors.length > 0 ? capability.behaviors : CONNECTOR_KINDS;
  const hideSyncOption = behaviorBase.includes('sync') && edge.kind !== 'sync';
  const behaviorOptions = hideSyncOption ? behaviorBase.filter((kind) => kind !== 'sync') : behaviorBase;
  const showCondition = showBehaviorPicker || Boolean(edge.condition);

  // Only offered where a connector already reads as an unambiguous synchronous call — see
  // `isSyncPairing`'s own doc comment for exactly which pairings that covers and why. A connector
  // that already carries a response never loses the section just because the pairing or kind
  // changed underneath it, same discipline as `showCondition` above.
  const canHaveResponse =
    Boolean(sourceNode && targetNode) &&
    isSyncPairing(categoryOf(sourceNode!), categoryOf(targetNode!)) &&
    (edge.kind === undefined || edge.kind === 'sync');
  const showRequestResponse = canHaveResponse || Boolean(edge.hasResponse);

  const currentAccentChip = edge.accent !== undefined ? theme.accents[edge.accent].chip : undefined;

  return (
    <div className="dc-edge-inspector-panel dc-edge-inspector-expanded">
      <section className="dc-inspector-section">
        <span className="dc-inspector-section-label">Interaction</span>
        <div className="dc-inspector-section-row">
          <select
            className="dc-inspector-control"
            aria-label="Interaction type"
            value={edge.semantic ?? ''}
            onChange={(event) =>
              store.getState().setEdgeSemantic(edge.id, (event.target.value || undefined) as EdgeSemantic | undefined)
            }
          >
            <option value="">No type</option>
            {EDGE_SEMANTICS.map((semantic) => (
              <option key={semantic} value={semantic}>
                {EDGE_SEMANTIC_LABELS[semantic]}
              </option>
            ))}
          </select>
          {showBehaviorPicker ? (
            <select
              className="dc-inspector-control"
              aria-label="Flow kind"
              title="Flow behaviour — a subtle visual treatment, not a label"
              value={edge.kind ?? ''}
              onChange={(event) =>
                store.getState().setEdgeKind(edge.id, (event.target.value || undefined) as ConnectorKind | undefined)
              }
            >
              <option value="">{capability?.behaviors.includes('sync') ? 'Sync' : 'No kind'}</option>
              {behaviorOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {CONNECTOR_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
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

      <section className="dc-inspector-section">
        <span className="dc-inspector-section-label">Route</span>
        <div className="dc-inspector-section-row">
          <select
            className="dc-inspector-control"
            aria-label="Connector shape"
            value={edge.routing}
            onChange={(event) =>
              store
                .getState()
                .updateEdgeById(edge.id, { routing: event.target.value as typeof edge.routing }, 'Change routing')
            }
          >
            <option value="smoothstep">Stepped</option>
            <option value="bezier">Curved</option>
            <option value="straight">Straight</option>
          </select>
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
