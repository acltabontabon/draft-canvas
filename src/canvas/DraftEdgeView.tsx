import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps } from '@xyflow/react';
import type { DraftNode } from '../document/types';
import { capabilityFor, categoryOf } from '../document/connectorSemantics';
import { explainEdgeTier, lensEdgeTier, stepIndexOf } from '../document/flow';
import { markerRef } from '../render/svg/markers';
import {
  LABEL_LINE_GAP,
  RESPONSE_SEED_SUFFIX,
  arrowSeed,
  endTangent,
  labelLaneOffset,
  laneIndex,
  rectOf,
  responseLaneFor,
  responseSpineFor,
  routeBetween,
  snappedAnchorForDrop,
  strokeSeed,
  type Rect,
  type Side,
  captionAnchor,
} from '../edges/routing';
import { routingPlan } from '../edges/bundles';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge, resolveEdgeColor } from '../edges/kindStyle';
import { attachmentRowBelowsSourceOrTarget, rectOfInternal } from './edgeGeometry';
import { AttachmentChipRow, type AttachmentActions } from './AttachmentPresentation';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { roughenPath } from '../render/roughness/roughPath';
import { sketchArrowPath } from '../render/roughness/roughArrow';
import { accentOf } from '../render/theme/tokens';
import { isEdgeFocused, lensFlow, useEditorStore } from '../store/editorStore';
import { selectEdge, selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { FONTS, cssFont } from '../render/text/fonts';

const NO_OBSTACLES: readonly Rect[] = [];

/** Minimum pointer movement, in screen pixels, before an endpoint gesture
 *  counts as a drag rather than a click — see `EdgeEndpointHandle`. */
const DRAG_THRESHOLD_PX = 4;

interface DragOverride {
  endpoint: 'source' | 'target';
  point: { x: number; y: number };
}

/** A degenerate rect at a single point — `anchorPoint` resolves it to exactly
 *  that point regardless of side/offset, which is what lets a live drag point
 *  stand in for a node's rect in `routeBetween` with no special-casing there. */
function pointRect(point: { x: number; y: number }): Rect {
  return { x: point.x, y: point.y, width: 0, height: 0 };
}

/**
 * Anchors the label chip to whichever side of the line `labelSide` picked, instead of centering
 * it on the line itself — the fix for a label visually cut through by its own connector. Only
 * this chip moves; the event dot, conditional diamond, caption, and condition chip all keep
 * anchoring straight at `(x, y)` as before, since they were never the ones being cut through.
 */
/** The side a request/response connector's reply label is forced to, relative to the request
 *  label's own side — guarantees "request above / response below" (or the left/right
 *  equivalent) across every routing mode, rather than leaving it to incidental agreement between
 *  the two independently-computed (source/target-swapped) routes' own `labelSide`. */
const OPPOSITE_SIDE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function labelChipTransform(side: Side, x: number, y: number): string {
  switch (side) {
    case 'right':
      return `translate(0, -50%) translate(${x + LABEL_LINE_GAP}px, ${y}px)`;
    case 'left':
      return `translate(-100%, -50%) translate(${x - LABEL_LINE_GAP}px, ${y}px)`;
    case 'top':
      return `translate(-50%, -100%) translate(${x}px, ${y - LABEL_LINE_GAP}px)`;
    case 'bottom':
      return `translate(-50%, 0) translate(${x}px, ${y + LABEL_LINE_GAP}px)`;
  }
}

/** Same idea for the condition chip — stacked below the caption for a horizontal line
 *  (unchanged), stacked beside the line for a vertical one. */
function conditionTransform(side: Side, x: number, y: number): string {
  switch (side) {
    case 'right':
      return `translate(0, 0) translate(${x + LABEL_LINE_GAP}px, ${y + 16}px)`;
    case 'left':
      return `translate(-100%, 0) translate(${x - LABEL_LINE_GAP}px, ${y + 16}px)`;
    case 'top':
    case 'bottom':
      return `translate(-50%, 0) translate(${x}px, ${y + 16}px)`;
  }
}

/** Gap between the connector's own label point and the attachment chip row — small, since a chip
 *  row is compact and doesn't need the same clearance a full label chip does. Matches the gap
 *  `attachmentRowBelowsSourceOrTarget` (in `edgeGeometry.ts`) itself probes from, and the one
 *  `EdgeInspectorPopover` uses for its own row, so nothing along this edge uses a different ruler. */
const ATTACHMENT_ROW_GAP = 12;

function attachmentRowTransform(x: number, y: number, flipBelow: boolean): string {
  return flipBelow
    ? `translate(-50%, 0) translate(${x}px, ${y + ATTACHMENT_ROW_GAP}px)`
    : `translate(-50%, -100%) translate(${x}px, ${y - ATTACHMENT_ROW_GAP}px)`;
}

/**
 * Connector rendering.
 *
 * Geometry comes from `routeBetween` — the same function the SVG exporter
 * calls — so an exported connector traces exactly the path drawn here. The
 * rectangles it is given come from React Flow's live node measurements rather
 * than from the document, which is what lets a connector follow a node smoothly
 * while it is being dragged, before anything has been committed.
 */
export const DraftEdgeView = memo(function DraftEdgeView({ id, selected }: EdgeProps) {
  const edge = useEditorStore((state) => selectEdge(state.document, id));
  // A primitive (an accent, or undefined), not the node object — so this
  // connector only re-renders when its *source's* colour actually changes,
  // and automatically follows both a recoloured source and a reconnected one.
  const sourceAccent = useEditorStore((state) => selectNode(state.document, edge?.source ?? '')?.accent);
  // A primitive, same reasoning as `sourceAccent` above — only re-renders when the pairing's
  // opinion of itself actually changes (e.g. a reconnect), not on every unrelated node edit. Not
  // Junction-transparent (unlike `EdgeInspectorPopover.tsx`'s own resolution): a false negative
  // (no marker on a Junction-mediated unusual pairing) is an acceptable, deliberately cheap
  // simplification for an ambient canvas hint — it never shows a *wrong* marker, only sometimes
  // omits one the popover's fuller resolution would have shown.
  const relationshipStatus = useEditorStore((state) => {
    const source = selectNode(state.document, edge?.source ?? '');
    const target = selectNode(state.document, edge?.target ?? '');
    return source && target ? capabilityFor(categoryOf(source), categoryOf(target))?.status : undefined;
  });
  const showSequence = useEditorStore((state) => state.document.settings.showSequence);
  const flows = useEditorStore((state) => state.document.flows);
  const flowPlayback = useEditorStore((state) => state.flowPlayback);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  // The flow object comes straight out of `document.flows`, so its identity only changes when the
  // flow itself does — this subscription doesn't re-render every edge on unrelated store writes.
  const lensFlowValue = useEditorStore(lensFlow);
  const focus = useEditorStore((state) => state.focus);
  const mode = useEditorStore((state) => state.mode);
  const updateEdgeLabel = useEditorStore((state) => state.updateEdgeLabel);
  const setEdgeCondition = useEditorStore((state) => state.setEdgeCondition);
  const updateEdgeAttachment = useEditorStore((state) => state.updateEdgeAttachment);
  const removeEdgeAttachment = useEditorStore((state) => state.removeEdgeAttachment);
  const detachEdgeAttachment = useEditorStore((state) => state.detachEdgeAttachment);
  const reorderEdgeAttachment = useEditorStore((state) => state.reorderEdgeAttachment);
  // Bound to this edge's own id here, since `AttachmentActions` takes only an attachment id — the
  // host id is already known to the caller, not something every attachment mutation should have
  // to repeat.
  const attachmentActions: AttachmentActions = useMemo(
    () => ({
      update: (attachmentId, patch) => updateEdgeAttachment(id, attachmentId, patch),
      remove: (attachmentId) => removeEdgeAttachment(id, attachmentId),
      detach: (attachmentId) => detachEdgeAttachment(id, attachmentId),
      reorder: (attachmentId, direction) => reorderEdgeAttachment(id, attachmentId, direction),
    }),
    [id, updateEdgeAttachment, removeEdgeAttachment, detachEdgeAttachment, reorderEdgeAttachment],
  );
  const theme = useThemeValue();
  const { preset } = usePersonality();

  // A primitive, not the `LaneAssignment` object — see `laneIndex`'s comment.
  // Only the edges whose own lane actually shifts re-render when a sibling
  // connector is added or removed between the same two nodes.
  const laneOffset = useEditorStore((state) => laneIndex(state.document.edges).get(id)?.offset ?? 0);
  // The shared fan-out/fan-in trunk this connector belongs to, if any. Safe to
  // subscribe to as an object: `routingPlan` is memoized on the (nodes, edges)
  // array pair, so an unchanged document hands back the very same spine and
  // zustand's default equality skips the re-render. A node move invalidates
  // the plan, but every bundled connector's geometry has genuinely changed by
  // then anyway.
  const spine = useEditorStore((state) => routingPlan(state.document.nodes, state.document.edges).spineFor(id));
  // Obstacle avoidance needs every other node's committed geometry, which no
  // per-edge subscription can narrow down further — so this one re-renders
  // whenever any node's position/size commits, not only its own endpoints.
  // Skipping it entirely while a gesture is in flight (see `interactionActive`
  // below) is what keeps that acceptable: the cost lands once per commit, not
  // per pointer-move frame, matching "cheap during interaction, refine after."
  const nodes = useEditorStore((state) => state.document.nodes);
  const interactionActive = useUiStore((state) => state.interactionActive);
  const attachTarget = useUiStore((state) => state.attachArmedEdgeTarget === id);

  const sourceNode = useInternalNode(edge?.source ?? '');
  const targetNode = useInternalNode(edge?.target ?? '');

  const [editing, setEditing] = useState(false);
  const stopEditing = useCallback(() => setEditing(false), []);
  // The condition chip is editable in place exactly like the label chip: anything a diagram shows
  // on a connector, the person looking at it can double-click and change — a route rule shouldn't
  // send them hunting for the inspector's own Condition field.
  const [editingCondition, setEditingCondition] = useState(false);
  const stopEditingCondition = useCallback(() => setEditingCondition(false), []);
  const editRequested = useUiStore((state) => state.editRequestId === id);
  const jumpFlash = useUiStore((state) => state.jumpFlashId === id);

  // Tracked in JS, not left to a pure `.dc-edge:hover` CSS rule: the response label lives in React
  // Flow's `EdgeLabelRenderer` portal, a sibling overlay div elsewhere in the DOM tree, not a real
  // descendant of this `<g>` — so no ancestor-based CSS selector can ever reach it, the same reason
  // `.dc-edge-label`'s own `data-active`/`data-dimmed`/etc. are passed as explicit props rather than
  // relied on to cascade from a parent. This one boolean covers both the response line (a real SVG
  // child, which *could* use plain `:hover`, but sharing one mechanism avoids two divergent ones)
  // and its portaled label.
  const [hoveringResponse, setHoveringResponse] = useState(false);

  // The live pointer position while this edge's own endpoint is being
  // dragged — local state, not the shared store, so only this one edge
  // re-renders per pointer-move frame. Exactly the same "stream to the
  // rendered element for smoothness, commit to the document only at the end"
  // pattern node dragging already uses (see the module doc comment above).
  const [dragOverride, setDragOverride] = useState<DragOverride | null>(null);

  // Same transient-id hook `DraftNodeView` uses for `Enter` — no ref-based
  // imperative API exists into this memoized component either.
  useEffect(() => {
    if (!editRequested) return;
    useUiStore.getState().requestEdit(null);
    // oxlint-disable-next-line set-state-in-effect -- one-shot external command, see comment above.
    if (mode !== 'present') setEditing(true);
  }, [editRequested, mode]);

  // Computed here, ahead of the early returns below, purely so the hooks
  // that follow (`lensPulsing`'s state/ref/effect) never run conditionally —
  // React requires the same hooks in the same order on every render, even
  // one where this edge (or a node it references) has just been deleted and
  // this component is about to render nothing. `edge` may still be
  // undefined at this point, hence the optional-chained guards throughout.
  const playingFlow = flowPlayback.active && flowPlayback.flowId
    ? flows.find((f) => f.id === flowPlayback.flowId)
    : undefined;
  const overlayFlow = selectedFlowId ? flows.find((f) => f.id === selectedFlowId) : undefined;
  const stepNumber = overlayFlow && edge ? stepIndexOf(overlayFlow, edge.id) : undefined;

  const tier = playingFlow && edge ? explainEdgeTier(stepIndexOf(playingFlow, edge.id), flowPlayback.step) : 'hidden';
  const isActiveStep = flowPlayback.active && tier === 'active';
  const isShownStep = flowPlayback.active && tier === 'shown';
  const dimmed = flowPlayback.active && tier === 'hidden';
  // Which of a request/response connector's two lines the active step's pulse animates — see
  // `FlowPlaybackState.phase`. Irrelevant, and always `'request'`, for a plain edge (no
  // `hasResponse`) or one not the active step, so existing single-line playback is entirely
  // unchanged.
  const pulseTarget: 'request' | 'response' =
    isActiveStep && edge?.hasResponse && flowPlayback.phase === 'response' ? 'response' : 'request';
  const focusDimmed = focus.active && edge ? !isEdgeFocused(focus, edge) : false;

  // Merely *selecting* a flow (not presenting it) is a gentler lens: every
  // member reads equally lit, there is no step progression — see
  // `lensEdgeTier`'s own comment for why this is a distinct primitive from
  // `explainEdgeTier` above, not a degenerate case of it. `lensFlow` decides
  // when the lens is on at all (not during Presentation/Focus, and not for an
  // empty flow); step badges above follow `selectedFlowId` regardless.
  const lensActive = lensFlowValue !== undefined;
  const lensTier = lensActive && edge ? lensEdgeTier(lensFlowValue, edge.id) : 'dimmed';
  const lensMember = lensActive && lensTier === 'member';
  const lensDimmed = lensActive && lensTier === 'dimmed';
  // The flow's own identity colour, temporarily worn by its member
  // connectors while it's the active lens — never a permanent per-edge
  // colour, since a connector can belong to several flows. See
  // `DraftFlow.accent`.
  const lensAccent = lensMember && lensFlowValue?.accent ? accentOf(theme, lensFlowValue.accent).chip : undefined;
  // Presentation gets the same identity colour, but only on the one
  // connector actively being explained right now — not every member at
  // once, the way the selection lens above does. Presentation already layers
  // its own active/shown/hidden opacity tiers; tinting all of them with the
  // flow's colour at the same time would read as busy rather than calm.
  const presentationAccent =
    isActiveStep && playingFlow?.accent ? accentOf(theme, playingFlow.accent).chip : undefined;
  const color =
    presentationAccent ?? lensAccent ?? (edge ? resolveEdgeColor(edge, { accent: sourceAccent }, theme) : theme.edge);

  // A brief, one-shot path pulse the moment this connector newly joins the
  // active lens (switching flows, or a flow being selected for the first
  // time) — not a loop like Presentation's `dc-flow-pulse`, and not
  // retriggered by anything else that causes a re-render.
  const [lensPulsing, setLensPulsing] = useState(false);
  // Keyed on the *lens* flow, not `selectedFlowId`: a lens appearing or switching is the moment
  // to pulse — which includes a brand-new flow gaining its first step, and excludes selecting an
  // empty one (no lens yet, nothing to announce).
  const lensFlowId = lensFlowValue?.id ?? null;
  const prevLensFlowRef = useRef(lensFlowId);
  useEffect(() => {
    // The `switched` guard, not the dependency array, is what actually
    // decides whether to pulse — so listing `lensMember` here only means the
    // effect also runs (and immediately no-ops) when it flips on its own
    // (e.g. presenting starts/stops) without the lens flow changing.
    const switched = prevLensFlowRef.current !== lensFlowId;
    prevLensFlowRef.current = lensFlowId;
    if (!switched || !lensMember) return;
    setLensPulsing(true);
    const timeout = setTimeout(() => setLensPulsing(false), 650);
    return () => clearTimeout(timeout);
  }, [lensFlowId, lensMember]);

  if (!edge || !sourceNode || !targetNode) return null;

  const sourceRect = rectOfInternal(sourceNode, nodes.find((node) => node.id === edge.source)?.type);
  const targetRect = rectOfInternal(targetNode, nodes.find((node) => node.id === edge.target)?.type);
  if (!sourceRect || !targetRect) return null;

  const obstacles = interactionActive
    ? NO_OBSTACLES
    : nodes
        .filter((node) => node.id !== edge.source && node.id !== edge.target && node.type !== 'group')
        .map(rectOf);

  // While an endpoint is being dragged, the path tracks the live pointer
  // position instead of the node it's still (until drop) actually attached
  // to — a degenerate zero-size rect at that point, which `anchorPoint`
  // already resolves to exactly that point regardless of side/offset. The
  // dragged end's persisted anchor is set aside too, so the route picks
  // whichever side reads best against the live point rather than fighting
  // to honour an anchor that's about to change anyway.
  const effectiveSourceRect = dragOverride?.endpoint === 'source' ? pointRect(dragOverride.point) : sourceRect;
  const effectiveTargetRect = dragOverride?.endpoint === 'target' ? pointRect(dragOverride.point) : targetRect;

  const route = routeBetween(effectiveSourceRect, effectiveTargetRect, edge.routing, {
    anchors: {
      source: dragOverride?.endpoint === 'source' ? undefined : edge.sourceAnchor,
      target: dragOverride?.endpoint === 'target' ? undefined : edge.targetAnchor,
    },
    lane: laneOffset,
    obstacles,
    // An endpoint being dragged is on its way out of this bundle — keeping it
    // on the trunk would rubber-band it back to a group it is leaving.
    spine: dragOverride ? undefined : spine,
  });
  // A label chip is far taller than the line's own lane nudge — extra
  // separation on top of it is what keeps parallel labels from stacking.
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, laneOffset);
  const labelX = route.labelX + labelNudge.x;
  const labelY = route.labelY + labelNudge.y;
  const attachmentFlipBelow = attachmentRowBelowsSourceOrTarget(labelX, labelY, sourceRect, targetRect);

  const hasLabel = Boolean(edge.label);
  const hasStep = showSequence && typeof stepNumber === 'number';
  // The step being explained is the one thing that should stand out.
  // `style` renders as an inline attribute, which always wins over an
  // external stylesheet rule — so a selected connector's stroke and width
  // must be decided here, not in CSS (only the halo in `canvas.css` — a
  // `filter`, never set inline — can safely live there). The active step
  // wears its flow's own accent when it has one (`presentationAccent`,
  // already folded into `color`); with no accent set, it falls back to the
  // plain selection colour exactly as it always has.
  const strokeColor =
    selected || attachTarget ? theme.selection : isActiveStep ? (presentationAccent ?? theme.selection) : color;
  const conditionText = edge.condition ? `[${edge.condition}]` : null;

  // Only the drawn stroke wobbles — every geometry value above (`route`,
  // `labelX`/`labelY`, attachment points) already reads from the unperturbed
  // route, matching `edges/describe.ts`'s dual-renderer contract. Hit-testing
  // below reads from `route.d` directly (never `drawnPath`), so it stays
  // exactly as precise as Clean regardless of how bold Sketch's wobble gets —
  // see the hit-path/decorative-path split further down.
  const profile = PERSONALITY_PROFILES[preset];
  // Bundle members each draw the whole shared trunk, so they must wobble it
  // identically or it frays into a rope — see `strokeSeed`.
  const seed = strokeSeed(edge.id, route.trunkLabel ? spine : undefined);
  const drawnPath = roughenPath(route.d, `${seed}:0`, profile.outline, profile.bow);
  const secondStrokePath = profile.strokes === 2 ? roughenPath(route.d, `${seed}:1`, profile.outline, profile.bow) : null;
  // Sketch draws its own arrowhead inline instead of referencing the shared marker — see
  // `render/roughness/roughArrow.ts`.
  const usesHandDrawnArrow = edge.directed && profile.arrowStyle === 'per-edge-hand';
  const arrowPath = usesHandDrawnArrow
    ? sketchArrowPath(
        route.target,
        endTangent(route, edge.routing, 'target'),
        arrowSeed(edge.id, route.trunkLabel ? spine : undefined),
        profile.arrowJitter,
        markerVariantForEdge(edge),
      )
    : null;

  // The reply half of a request/response connector — reuses `routeBetween` a second time with
  // source/target (and their anchors) swapped, so the path naturally runs target → source, and a
  // small addition to this edge's own lane slot, so it reads as a quieter sibling of the request
  // line rather than a whole new routing system. `responseRoute.target` therefore lands on the
  // *original source* node — that's what makes its `markerEnd` correctly point back at A; don't
  // "fix" the apparent reversal. See `responseLaneFor`'s own doc comment in `edges/routing.ts`.
  const responseLane = responseLaneFor(laneOffset);
  const responseRoute = edge.hasResponse
    ? routeBetween(effectiveTargetRect, effectiveSourceRect, edge.routing, {
        anchors: {
          source: dragOverride?.endpoint === 'target' ? undefined : edge.targetAnchor,
          target: dragOverride?.endpoint === 'source' ? undefined : edge.sourceAnchor,
        },
        lane: responseLane,
        obstacles,
        spine: dragOverride ? undefined : responseSpineFor(spine),
      })
    : null;
  const responseDrawnPath = responseRoute
    ? roughenPath(responseRoute.d, `${seed}${RESPONSE_SEED_SUFFIX}`, profile.outline, profile.bow)
    : null;
  const responseUsesHandDrawnArrow = responseRoute && edge.directed && profile.arrowStyle === 'per-edge-hand';
  const responseArrowPath = responseUsesHandDrawnArrow
    ? sketchArrowPath(
        responseRoute.target,
        endTangent(responseRoute, edge.routing, 'target'),
        `${edge.id}:response-head`,
        profile.arrowJitter,
        'open',
      )
    : null;
  // Deliberately *not* `labelLaneOffset` here: that helper adds real-sibling-edge label
  // clearance on top of an already-lane-nudged line, for when a 10px line gap isn't enough
  // room for two separate edges' full-height label chips to avoid stacking. The response
  // route's own path is already comfortably separated from the request line by
  // `RESPONSE_LANE_DELTA`, so its label only needs the same small perpendicular clearance the
  // request label gets from its own line (`labelChipTransform`'s `LABEL_LINE_GAP`) — stacking
  // the sibling nudge on top of that pushed the response label tens of pixels further away
  // than the line it's meant to sit right against.
  const responseLabelX = responseRoute ? responseRoute.labelX : 0;
  const responseLabelY = responseRoute ? responseRoute.labelY : 0;
  // Compact by default; the response's own half of a two-phase presentation pulse also counts as
  // "useful to see right now", same as hover/selection.
  const responseRevealed = selected || hoveringResponse || pulseTarget === 'response';

  return (
    <g
      className="dc-edge"
      data-selected={selected ? 'true' : undefined}
      data-active={isActiveStep ? 'true' : undefined}
      data-shown={isShownStep ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      data-focus-dimmed={focusDimmed ? 'true' : undefined}
      data-flow-active={isActiveStep ? pulseTarget : undefined}
      data-attach-target={attachTarget ? 'true' : undefined}
      data-lens-member={lensMember ? 'true' : undefined}
      data-jump-flash={jumpFlash ? 'true' : undefined}
      data-lens-dimmed={lensDimmed ? 'true' : undefined}
      data-lens-pulse={lensPulsing ? 'true' : undefined}
      onPointerEnter={responseRoute ? () => setHoveringResponse(true) : undefined}
      onPointerLeave={responseRoute ? () => setHoveringResponse(false) : undefined}
    >
{/*
        Two sibling paths, same shape `BaseEdge` itself renders internally — but decoupled onto
        different `d`s. The invisible, wide interaction path always uses the canonical `route.d`,
        never `drawnPath`, so this edge's click/hover/reconnect hit area stays exactly as precise
        as Clean at every preset, regardless of how far Sketch's wobble pushes the visible stroke.
        Class names match what `BaseEdge` used, so React Flow's own click dispatch (bound to the
        ancestor `.react-flow__edge`, not to either path itself) and `.react-flow__edge-interaction`'s
        cursor styling keep working unchanged.
      */}
      <path
        className="dc-edge-hit react-flow__edge-interaction"
        d={route.d}
        fill="none"
        strokeOpacity={0}
        strokeWidth={18}
      />
      <path
        className="react-flow__edge-path dc-edge-line"
        d={drawnPath}
        fill="none"
        pointerEvents="none"
        markerEnd={edge.directed && !usesHandDrawnArrow ? markerRef(strokeColor, markerVariantForEdge(edge)) : undefined}
        style={{
          stroke: strokeColor,
          strokeWidth: isActiveStep ? 2.6 : selected || attachTarget ? 2.4 : lensMember ? 2.0 : 1.6,
          strokeLinecap: 'round',
          strokeDasharray: dashForEdge(edge)?.join(' '),
        }}
      />
      {secondStrokePath && (
        <path
          className="dc-edge-line-second"
          d={secondStrokePath}
          fill="none"
          pointerEvents="none"
          style={{
            stroke: strokeColor,
            strokeWidth: 1,
            strokeLinecap: 'round',
            opacity: 0.5,
          }}
        />
      )}
      {arrowPath && (
        <path
          className="dc-edge-arrow"
          d={arrowPath}
          pointerEvents="none"
          fill={markerVariantForEdge(edge) === 'closed' ? strokeColor : 'none'}
          stroke={markerVariantForEdge(edge) === 'open' ? strokeColor : undefined}
          strokeWidth={markerVariantForEdge(edge) === 'open' ? 1.3 : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {responseDrawnPath && (
        // Deliberately *not* `pointerEvents="none"`: unlike the second stroke and the arrowhead,
        // this is a real interactive affordance — hovering directly over it is how
        // `hoveringResponse`/`responseRevealed` gets set, and it has no separate wide hit path of
        // its own the way the primary line does, so roughening it doesn't widen or blur any
        // existing hitbox — its clickable area was always just this thin stroke.
        <path
          className="dc-edge-response-line"
          data-revealed={responseRevealed ? 'true' : undefined}
          d={responseDrawnPath}
          fill="none"
          markerEnd={edge.directed && !responseUsesHandDrawnArrow ? markerRef(strokeColor, 'open') : undefined}
          style={{
            stroke: strokeColor,
            strokeWidth: 1,
            strokeLinecap: 'round',
            strokeDasharray: RESPONSE_DASH.join(' '),
          }}
        />
      )}
      {responseArrowPath && (
        <path
          className="dc-edge-response-arrow"
          d={responseArrowPath}
          pointerEvents="none"
          fill="none"
          stroke={strokeColor}
          strokeWidth={1.3}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.8}
        />
      )}

      {/* A small glyph at the path's midpoint — see the matching comment in
          `edges/describe.ts`. Only when nothing else already occupies that spot. */}
      {!hasLabel && !hasStep && edge.kind === 'event' && (
        <circle cx={labelX} cy={labelY} r={3} fill={strokeColor} />
      )}
      {!hasLabel && !hasStep && edge.kind === 'conditional' && (
        <polygon
          points={`${labelX},${labelY - 5} ${labelX + 5},${labelY} ${labelX},${labelY + 5} ${labelX - 5},${labelY}`}
          fill={theme.edgeLabelBg}
          stroke={strokeColor}
          strokeWidth={1.3}
        />
      )}
      {/* Async's own visual cue — two short diagonal ticks at the path's midpoint, the
          conventional "cable break" glyph, so an async call reads as one at a glance without
          resorting to a dashed *request* line (that's `edge.async`'s own, deliberately separate,
          concern — see `setEdgeKind`'s doc comment in `editorStore.ts`). Unlike the event/
          conditional glyphs above, this shows *alongside* a real label — it sits on the line
          itself, not in the label chip's own off-path spot, so the two never compete for room.
          Deliberately not rotated to match the local path tangent: the same fixed diagonal glyph
          reads fine crossing a horizontal run, but for a vertical one it would visually merge
          into the line it's meant to interrupt — see the `isVerticalConnector` branch below,
          which is the one thing that *does* differ by orientation, and only to keep the glyph
          itself looking identical either way. */}
      {edge.kind === 'async' &&
        !edge.async &&
        (() => {
          // `labelSideFor` (`edges/routing.ts`) already resolved this exact question when it
          // picked the label's own side: 'left'/'right' means it read the connector as more
          // vertical than horizontal, 'top'/'bottom' the reverse — reusing it here keeps the
          // marker's orientation call and the label's own placement never able to disagree.
          const isVerticalConnector = route.labelSide === 'left' || route.labelSide === 'right';
          return (
            <g className="dc-edge-async-marker">
              {isVerticalConnector && (
                // A small masked gap so the two ticks sit *inside* a break in the line rather
                // than crossing an unbroken run — on a vertical connector the fixed-diagonal
                // glyph would otherwise read as a stray zigzag on top of the line instead of an
                // interruption of it. Filled with the theme's own canvas colour, the same
                // "erase, don't compute a real path split" trick the edge labels' own halo
                // already relies on — see `styles/canvas.css`'s `.dc-edge-label`.
                <rect x={labelX - 4} y={labelY - 8} width={8} height={16} fill={theme.canvas} />
              )}
              <g stroke={strokeColor} strokeWidth={1.6} strokeLinecap="round">
                <line x1={labelX - 5.5} y1={labelY + 5} x2={labelX - 1.5} y2={labelY - 5} />
                <line x1={labelX + 1.5} y1={labelY + 5} x2={labelX + 5.5} y2={labelY - 5} />
              </g>
            </g>
          );
        })()}
      {/* A subtle caption of the relationship — independent of `kind`'s glyph above, so a plain
          call/read/write connector reads just as clearly as an event one. Yields entirely to a
          real label the moment there is one. A request/response connector now gets one too (see
          `relationshipCaptionLabel`) — the two-line shape communicates "this is a call," but not
          *what kind* of call, which is exactly what left a fresh Service→Service connector with
          no visible text at all. `captionAnchor`'s `awayFromResponse` flag is what keeps this from
          landing on top of the response line's own label — see its own doc comment. */}
      {!hasLabel && !hasStep && edge.semantic && (() => {
        const isUnusual = relationshipStatus === 'unusual' || relationshipStatus === 'questionable';
        // A bundle's members all share one relationship, so repeating its
        // caption down every branch is the exact "calls / calls / calls"
        // column Smart Routing exists to remove: every member draws it at the
        // same point on the shared stem instead, where the identical copies
        // overdraw into one label. An architecturally unusual pairing keeps
        // its own caption on its own branch — that warning is about this
        // relationship, not its siblings. Mirrors `edges/describe.ts`.
        const collapsed = Boolean(route.trunkLabel) && !isUnusual;
        const captionAt = collapsed ? route.trunkLabel! : { x: labelX, y: labelY };
        const captionSide = collapsed ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide;
        const caption = captionAnchor(captionSide, captionAt.x, captionAt.y, edge.hasResponse ? Math.sign(responseLane) : 0);
        const label = relationshipCaptionLabel(edge.semantic, edge.hasResponse, edge.deliveryAttempts);
        return (
          <text
            x={caption.x}
            y={caption.y}
            textAnchor={caption.textAnchor}
            dominantBaseline={caption.dominantBaseline}
            fill={isUnusual ? theme.accents.amber.text : theme.textFaint}
            style={{ font: cssFont(FONTS.connectorCaption) }}
          >
            {isUnusual ? `▲ ${label}` : label}
          </text>
        );
      })()}

      <EdgeLabelRenderer>
        {/*
          Draggable endpoint handles. Rendered here, in React Flow's HTML
          overlay portal — which always paints above the nodes layer — rather
          than as SVG elements alongside the path: a node's own connection
          handles keep real pointer events at every opacity (see their CSS
          comment) and physically sit at these same coordinates, so anything
          drawn in the SVG layer underneath the nodes can never win the
          pointer-down that starts a drag. Driven entirely by hand — not
          React Flow's `onReconnect`/`edgesReconnectable` — for the same
          reason: those key off React Flow's own handle-position lookup,
          which has no notion of this app's per-side offsets or custom routing.
        */}
        {selected && mode !== 'present' && (
          <>
            <EdgeEndpointHandle
              edgeId={edge.id}
              endpoint="source"
              x={route.source.x}
              y={route.source.y}
              nodes={nodes}
              onDrag={setDragOverride}
            />
            <EdgeEndpointHandle
              edgeId={edge.id}
              endpoint="target"
              x={route.target.x}
              y={route.target.y}
              nodes={nodes}
              onDrag={setDragOverride}
            />
          </>
        )}

        {(hasLabel || editing) && (
          <div
            className="dc-edge-label"
            data-editing={editing ? 'true' : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-active={isActiveStep ? 'true' : undefined}
            data-lens-dimmed={lensDimmed ? 'true' : undefined}
            style={{ transform: labelChipTransform(route.labelSide, labelX, labelY) }}
            onDoubleClick={() => mode === 'edit' && setEditing(true)}
          >
            {hasStep && (
              <span className="dc-edge-label-step" style={{ color }}>
                {stepNumber}
              </span>
            )}
            {editing ? (
              <input
                autoFocus
                className="dc-edge-label-input"
                defaultValue={edge.label ?? ''}
                spellCheck={false}
                onBlur={(event) => {
                  updateEdgeLabel(edge.id, event.currentTarget.value.trim());
                  stopEditing();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    updateEdgeLabel(edge.id, event.currentTarget.value.trim());
                    stopEditing();
                  }
                  if (event.key === 'Escape') stopEditing();
                }}
              />
            ) : (
              edge.label
            )}
          </div>
        )}

        {/*
          A standalone badge only when there is no label to carry it. On a short
          connector the two would otherwise sit on top of each other.
        */}
        {hasStep && !hasLabel && !editing && (
          <div
            className="dc-edge-step"
            data-active={isActiveStep ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-lens-dimmed={lensDimmed ? 'true' : undefined}
            style={{
              transform: `translate(-50%, -50%) translate(${badgeX(route)}px, ${badgeY(route)}px)`,
              borderColor: color,
              color,
            }}
          >
            {stepNumber}
          </div>
        )}

        {conditionText && (
          <div
            className="dc-edge-meta"
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-active={isActiveStep ? 'true' : undefined}
            data-lens-dimmed={lensDimmed ? 'true' : undefined}
            style={{
              transform: conditionTransform(route.labelSide, labelX, labelY),
            }}
          >
            <span
              className="dc-edge-condition"
              data-editing={editingCondition ? 'true' : undefined}
              style={{ color }}
              title={mode === 'edit' && !editingCondition ? 'Double-click to edit' : undefined}
              onDoubleClick={() => mode === 'edit' && setEditingCondition(true)}
            >
              {editingCondition ? (
                <input
                  autoFocus
                  className="dc-edge-condition-input"
                  aria-label="Condition"
                  defaultValue={edge.condition ?? ''}
                  spellCheck={false}
                  onBlur={(event) => {
                    setEdgeCondition(edge.id, event.currentTarget.value.trim());
                    stopEditingCondition();
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      setEdgeCondition(edge.id, event.currentTarget.value.trim());
                      stopEditingCondition();
                    }
                    if (event.key === 'Escape') stopEditingCondition();
                  }}
                />
              ) : (
                conditionText
              )}
            </span>
          </div>
        )}

        {/* The reply half of a request/response connector — anchored to the response route's own
            label point (already offset from the primary by `RESPONSE_LANE_DELTA`), not the
            primary's, so it never stacks on the label/condition/step/attachment cluster above,
            and forced to `OPPOSITE_SIDE` of the request label so "request above / response
            below" (or the left/right equivalent) holds regardless of what each independently-
            computed route's own `labelSide` happens to agree on. Compact by default, revealed on
            hover/selection via `canvas.css`, not a new piece of React state. */}
        {edge.response && (
          <div
            className="dc-edge-response-label"
            data-revealed={responseRevealed ? 'true' : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-active={isActiveStep ? 'true' : undefined}
            data-lens-dimmed={lensDimmed ? 'true' : undefined}
            style={{
              transform: labelChipTransform(OPPOSITE_SIDE[route.labelSide], responseLabelX, responseLabelY),
            }}
          >
            {edge.response}
          </div>
        )}

        {/* Mounted only when there is something to reveal — no cost, no listeners, when an
            edge has no attachment. Stays mounted in presentation mode (click-to-reveal still
            works there); only pinning into edit mode is gated to edit mode, below. */}
        {edge.attachments?.length ? (
          <AttachmentChipRow
            hostKind="edge"
            hostId={edge.id}
            attachments={edge.attachments}
            cardSide={attachmentFlipBelow ? 'below' : 'above'}
            editable={mode !== 'present'}
            actions={attachmentActions}
            dimmed={lensDimmed}
            style={{ position: 'absolute', transform: attachmentRowTransform(labelX, labelY, attachmentFlipBelow) }}
          />
        ) : null}
      </EdgeLabelRenderer>
    </g>
  );
});

/**
 * One draggable connector endpoint. Grabbing it and dropping it on a node
 * (the same one, a different side, or an entirely different node) reconnects
 * that end; dropping on empty canvas is a no-op — the connection is never
 * touched until a valid drop commits it, and Escape cancels outright.
 *
 * Hit-testing mirrors `Canvas.tsx`'s `onConnectEnd`: node rectangles straight
 * from the document, topmost z first, groups excluded. Target highlighting
 * only writes to the store when the hovered node id actually changes, so a
 * drag does not re-render anything on every pointer-move frame.
 */
function EdgeEndpointHandle({
  edgeId,
  endpoint,
  x,
  y,
  nodes,
  onDrag,
}: {
  edgeId: string;
  endpoint: 'source' | 'target';
  x: number;
  y: number;
  nodes: DraftNode[];
  onDrag: (override: DragOverride | null) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const cancelled = useRef(false);
  const lastHover = useRef<string | null>(null);
  // A plain click always carries a pixel or two of pointer jitter between
  // down and up — without a real-movement threshold, that jitter alone was
  // enough to nudge the connector's anchor or even hop it to a neighbouring
  // node, which read as "clicking a node drags it." Nothing (the live
  // preview, target highlighting, the eventual reconnect) engages until the
  // pointer has actually moved past this distance.
  const dragStarted = useRef(false);
  const startClient = useRef<{ x: number; y: number } | null>(null);

  // A single pass tracking the highest-z match is equivalent to (and cheaper
  // than) copying + sorting the whole array on every pointer-move frame of a
  // reconnect drag — same result, no allocation, no O(n log n) sort.
  const findDropNode = useCallback(
    (point: { x: number; y: number }) => {
      let best: DraftNode | undefined;
      for (const node of nodes) {
        if (node.type === 'group') continue;
        if (
          point.x < node.x ||
          point.x > node.x + node.width ||
          point.y < node.y ||
          point.y > node.y + node.height
        ) {
          continue;
        }
        if (!best || node.z > best.z) best = node;
      }
      return best;
    },
    [nodes],
  );

  const onKeyDownRef = useRef<(event: KeyboardEvent) => void>(undefined);

  const endDrag = useCallback(() => {
    if (onKeyDownRef.current) window.removeEventListener('keydown', onKeyDownRef.current);
    useUiStore.getState().setReconnectHoverTarget(null);
    useUiStore.getState().setReconnectDragActive(false);
    useUiStore.getState().setArmedAnchor(null);
    useUiStore.getState().setInteractionActive(false);
    lastHover.current = null;
    dragStarted.current = false;
    startClient.current = null;
    onDrag(null);
  }, [onDrag]);

  // `endDrag` already runs on a normal pointer-up/Escape, but if the component unmounts mid-drag
  // — this edge is deleted while its endpoint is being dragged, or `mode` flips to `'present'`
  // (which un-renders this handle entirely) — that path never runs. Without also resetting the
  // shared `uiStore` fields here, `interactionActive` is left stuck `true`, which silently
  // disables obstacle-avoidance/lane recomputation for every edge on the canvas until an
  // unrelated gesture happens to flip it back off. `endDrag` is written to be idempotent
  // (resetting already-idle state is a no-op), so calling it unconditionally on unmount is safe.
  const endDragRef = useRef(endDrag);
  useEffect(() => {
    endDragRef.current = endDrag;
  }, [endDrag]);
  useEffect(() => {
    return () => {
      if (onKeyDownRef.current) window.removeEventListener('keydown', onKeyDownRef.current);
      endDragRef.current();
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      cancelled.current = false;
      dragStarted.current = false;
      startClient.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      onKeyDownRef.current = (keyEvent) => {
        if (keyEvent.key !== 'Escape') return;
        cancelled.current = true;
        endDrag();
      };
      window.addEventListener('keydown', onKeyDownRef.current);
    },
    [endDrag],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (cancelled.current) return;
      if (!dragStarted.current) {
        const start = startClient.current;
        if (!start) return;
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved < DRAG_THRESHOLD_PX) return; // Still just a click so far.
        dragStarted.current = true;
        useUiStore.getState().setInteractionActive(true);
        useUiStore.getState().setReconnectDragActive(true);
      }
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onDrag({ endpoint, point });
      const node = findDropNode(point);
      const hoverId = node?.id ?? null;
      if (hoverId !== lastHover.current) {
        lastHover.current = hoverId;
        useUiStore.getState().setReconnectHoverTarget(hoverId);
      }
      // Live "release here" preview — the hand-rolled counterpart to React
      // Flow's own `.connectingto.valid`, which only tracks its native
      // connection-creation drag, not this one. Snapped, and `undefined`
      // exactly when the eventual drop would leave the anchor dynamic (see
      // `snappedAnchorForDrop`), so the highlight never promises a specific
      // point the commit wouldn't actually capture.
      const anchor = node ? snappedAnchorForDrop(rectOf(node), point) : undefined;
      useUiStore.getState().setArmedAnchor(anchor && node ? { nodeId: node.id, ...anchor } : null);
    },
    [endpoint, findDropNode, onDrag, screenToFlowPosition],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.releasePointerCapture(event.pointerId);
      const wasCancelled = cancelled.current;
      const didDrag = dragStarted.current;
      endDrag();
      if (wasCancelled || !didDrag) return; // A plain click never reconnects anything.
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = findDropNode(point);
      if (!node) return; // Empty canvas: leave the connection exactly as it was.
      const anchor = snappedAnchorForDrop(rectOf(node), point);
      useEditorStore.getState().reconnectEdge(edgeId, endpoint, node.id, anchor?.side, anchor?.offset);
    },
    [edgeId, endDrag, endpoint, findDropNode, screenToFlowPosition],
  );

  // An interrupted gesture (e.g. a touch/stylus drag cancelled by the OS) fires `pointercancel`
  // instead of `pointerup` — without a handler for it, nothing ever called `endDrag()`, leaving
  // the drag preview and `uiStore`'s reconnect flags stuck exactly as `onPointerUp` would if it
  // were simply never called. No commit here, same as an Escape cancel.
  const onPointerCancel = useCallback(() => {
    cancelled.current = true;
    endDrag();
  }, [endDrag]);

  return (
    <div
      className="dc-edge-endpoint"
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  );
}

/** Mirrors `badgePoint` in `edges/describe.ts`, in screen coordinates. */
const BADGE_OFFSET = 22;

function badgeX(route: ReturnType<typeof routeBetween>): number {
  // Every member of a fan-out leaves its hub from the same anchor, so walking
  // outward from `source` would stack all N badges on one point — see
  // `badgePoint` in `edges/describe.ts`.
  if (route.branchStart) return route.branchStart.x + Math.sign(route.target.x - route.branchStart.x) * BADGE_OFFSET;
  const side = route.source.side;
  if (side === 'left') return route.source.x - BADGE_OFFSET;
  if (side === 'right') return route.source.x + BADGE_OFFSET;
  return route.source.x;
}

function badgeY(route: ReturnType<typeof routeBetween>): number {
  if (route.branchStart) return route.branchStart.y + Math.sign(route.target.y - route.branchStart.y) * BADGE_OFFSET;
  const side = route.source.side;
  if (side === 'top') return route.source.y - BADGE_OFFSET;
  if (side === 'bottom') return route.source.y + BADGE_OFFSET;
  return route.source.y;
}

