import { useEffect, useRef, useState } from 'react';
import { ViewportPortal, useInternalNode } from '@xyflow/react';
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

/** Gap between the connector's own label point and the popover — matches
 *  `EdgeAttachmentRow`'s gap so the two never feel like they use different rulers. */
const POPOVER_GAP = 12;

type PanelKind = 'semantic' | 'membership' | 'advanced';

/**
 * The contextual control for a single selected connector — anchored at its
 * own label point instead of docked at the bottom of the screen (the thing
 * `Inspector.tsx`'s old `EdgeControls`/`EdgeFlowMembership` did). Mounted
 * only while exactly one edge, and no node, is selected; `Inspector` itself
 * no longer renders anything for that case, so this is the only edge UI a
 * single-connector selection shows.
 *
 * Everything beyond the compact row (label→semantic, flows→membership,
 * ⋯→everything else) is progressive disclosure: at most one of the three
 * expands at a time, mirroring the one-thing-open-at-once discipline
 * `EdgeAttachmentChip` already uses for attachment cards.
 */
export function EdgeInspectorPopover() {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const store = useEditorStore;
  const theme = useThemeValue();

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
  const flipBelow = attachmentRowBelowsSourceOrTarget(route.labelX, route.labelY, sourceRect, targetRect);

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
        <button
          type="button"
          className="dc-edge-inspector-caption"
          data-empty={caption ? undefined : 'true'}
          title="Edit connection type"
          onClick={() => toggle('semantic')}
        >
          {caption ?? 'Add type…'}
        </button>
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
          active={panel === 'advanced'}
          onClick={() => toggle('advanced')}
        >
          ⋯
        </Button>
      </div>

      {panel === 'semantic' && <SemanticPanel edge={edge} store={store} onDone={() => setPanel(null)} />}
      {panel === 'membership' && <MembershipPanel edgeId={edge.id} store={store} />}
      {panel === 'advanced' && (
        <AdvancedPanel edge={edge} sourceNode={sourceNode} targetNode={targetNode} theme={theme} store={store} />
      )}
    </>
  );
}

function SemanticPanel({
  edge,
  store,
  onDone,
}: {
  edge: DraftEdge;
  store: typeof useEditorStore;
  onDone: () => void;
}) {
  return (
    <div className="dc-edge-inspector-panel">
      <select
        className="dc-select"
        autoFocus
        aria-label="Connection type"
        value={edge.semantic ?? ''}
        onChange={(event) => {
          store.getState().setEdgeSemantic(edge.id, (event.target.value || undefined) as EdgeSemantic | undefined);
          onDone();
        }}
      >
        <option value="">No type</option>
        {EDGE_SEMANTICS.map((semantic) => (
          <option key={semantic} value={semantic}>
            {EDGE_SEMANTIC_LABELS[semantic]}
          </option>
        ))}
      </select>
    </div>
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

/** The rest of what `EdgeControls` used to show inline, all at once, now
 *  behind the overflow toggle: arrow, routing shape, behaviour/kind,
 *  condition, and this connector's own colour override. */
function AdvancedPanel({
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
  const [editingResponse, setEditingResponse] = useState(false);

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
  // that already carries a response never loses the control just because the pairing or kind
  // changed underneath it, same discipline as `showCondition` above.
  const canHaveResponse =
    Boolean(sourceNode && targetNode) &&
    isSyncPairing(categoryOf(sourceNode!), categoryOf(targetNode!)) &&
    (edge.kind === undefined || edge.kind === 'sync');
  const showResponse = canHaveResponse || Boolean(edge.response);
  const showResponseInput = editingResponse || Boolean(edge.response);

  return (
    <div className="dc-edge-inspector-panel dc-edge-inspector-panel-advanced">
      <Button
        variant="ghost"
        active={edge.directed}
        title="Show an arrowhead"
        onClick={() => store.getState().updateEdgeById(edge.id, { directed: !edge.directed }, 'Change direction')}
      >
        Arrow
      </Button>
      <select
        className="dc-select"
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
      {showBehaviorPicker ? (
        <select
          className="dc-select"
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
            className="dc-kind-badge"
            title="Inferred from what this connects — click to change"
            onClick={() => setEditingBehavior(true)}
          >
            {behaviorBadgeLabel(capability.defaultBehavior)}
          </button>
        )
      )}
      {showCondition && (
        <input
          className="dc-input dc-input-condition"
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
      {showResponse && (
        <select
          className="dc-select"
          aria-label="Response"
          title="An optional reply, drawn as a quieter secondary line — see the connector's own tooltip"
          value={edge.response ? 'custom' : 'none'}
          onChange={(event) => {
            const choice = event.target.value;
            if (choice === 'none') {
              setEditingResponse(false);
              store.getState().setEdgeResponse(edge.id, '');
              return;
            }
            if (choice === 'success') {
              store.getState().setEdgeResponse(edge.id, inferSuccessResponse(edge.label));
              setEditingResponse(true);
              return;
            }
            setEditingResponse(true);
          }}
        >
          <option value="none">No response</option>
          <option value="success">Success</option>
          <option value="custom">Custom…</option>
        </select>
      )}
      {showResponseInput && (
        <input
          className="dc-input dc-input-response"
          aria-label="Response text"
          placeholder="Response…"
          defaultValue={edge.response ?? ''}
          spellCheck={false}
          onBlur={(event) => {
            store.getState().setEdgeResponse(edge.id, event.currentTarget.value);
            setEditingResponse(false);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setEditingResponse(false);
          }}
        />
      )}
      <span className="dc-inspector-divider" />
      <div className="dc-swatches">
        {ACCENTS.map((accent) => (
          <button
            key={accent}
            type="button"
            className="dc-swatch"
            title={accent}
            aria-label={`Colour ${accent}`}
            style={{ background: theme.accents[accent].chip }}
            onClick={() => store.getState().updateEdgeById(edge.id, { accent }, 'Recolour')}
          />
        ))}
        {edge.accent !== undefined && (
          <Button
            variant="ghost"
            title="Derive this connection's colour from its source node instead of a fixed one"
            onClick={() => store.getState().updateEdgeById(edge.id, { accent: undefined }, 'Reset colour')}
          >
            Auto
          </Button>
        )}
      </div>
    </div>
  );
}
