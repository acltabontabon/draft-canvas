import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LIMITS } from '../document/limits';
import { useInternalNode, useReactFlow, type EdgeProps } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import type { DraftNode } from '../document/types';
import { capabilityFor, categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { edgeTierAt, findFlow, lensEdgeTier, stepIndexOf, type ExplainTier } from '../document/flow';
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
import { labelGroupPlan, labelLeader, pointAlong } from '../edges/labelGroups';
import { LABEL_PADDING_X, LABEL_PADDING_Y, layoutEdgeLabel, layoutEdgeResponse } from '../edges/labelLayout';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge, resolveEdgeColor } from '../edges/kindStyle';
import { EdgeLabels } from './EdgeLabels';
import { ATTACHMENT_ROW_GAP, attachmentRowBelowsSourceOrTarget, captionSideOf, rectOfInternal } from './edgeGeometry';
import { obstaclesForEdge, withoutNodes } from '../edges/obstacles';
import { badgeCrowds, badgePoint } from '../edges/badgePoint';
import { bridgePath } from '../edges/bridge';
import { NO_CROSSINGS, crossingPlan, withoutMoving } from '../edges/crossings';
import { AttachmentChipRow, type AttachmentActions } from './AttachmentPresentation';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { roughenPath } from '../render/roughness/roughPath';
import { sketchArrowPath } from '../render/roughness/roughArrow';
import { accentOf } from '../render/theme/tokens';
import { isEdgeFocused, lensFlow, useEditorStore, type EditorStore } from '../store/editorStore';
import { selectEdge, selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { FONTS, cssFont } from '../render/text/fonts';
import { Lru } from '../lib/lru';
import { pointInBox } from '../lib/math';
import { isImeKeyEvent } from '../lib/isEditableTarget';

const NO_OBSTACLES: readonly Rect[] = [];

interface EdgeRoutes {
  request: ReturnType<typeof routeBetween>;
  response: ReturnType<typeof routeBetween> | null;
}

/** Routing is pure in its inputs, so results are shared by key across every connector. Room for
 *  every connector a document may hold — smaller, a render that touches them all evicts routes
 *  still on screen and recomputes most of them. */
const ROUTES = new Lru<string, EdgeRoutes>(LIMITS.maxEdges);

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

/** The side a request/response connector's reply label is forced to, relative to the request
 *  label's own side — guarantees "request above / response below" (or the left/right
 *  equivalent) across every routing mode, rather than leaving it to incidental agreement between
 *  the two independently-computed (source/target-swapped) routes' own `labelSide`. */
const OPPOSITE_SIDE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Anchors the label chip to whichever side of the line `labelSide` picked, instead of centering
 * it on the line itself — the fix for a label visually cut through by its own connector. Only
 * this chip moves; the event dot, conditional diamond, caption, and condition chip all keep
 * anchoring straight at `(x, y)` as before, since they were never the ones being cut through.
 */
function labelChipTransform(side: Side, x: number, y: number): string {
  // Set back by the chip's padding, so the text — not the chip — is `LABEL_LINE_GAP` from the line,
  // where a relationship caption's text sits.
  switch (side) {
    case 'right':
      return `translate(0, -50%) translate(${x + LABEL_LINE_GAP - LABEL_PADDING_X}px, ${y}px)`;
    case 'left':
      return `translate(-100%, -50%) translate(${x - LABEL_LINE_GAP + LABEL_PADDING_X}px, ${y}px)`;
    case 'top':
      return `translate(-50%, -100%) translate(${x}px, ${y - LABEL_LINE_GAP + LABEL_PADDING_Y}px)`;
    case 'bottom':
      return `translate(-50%, 0) translate(${x}px, ${y + LABEL_LINE_GAP - LABEL_PADDING_Y}px)`;
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

/** The chip row hangs `ATTACHMENT_ROW_GAP` off the label point — small, since a chip row is compact
 *  and doesn't need the clearance a full label chip does. Shared from `edgeGeometry.ts` so the probe
 *  in `attachmentRowBelowsSourceOrTarget` and Presentation Mode's callout anchor use the same ruler. */
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
  // The pairing is read as one `"source>target"` category string, again a primitive, so both the
  // status marker and the caption's direction-aware wording (`relationshipCaptionLabel`) derive
  // from the same subscription.
  const pairing = useEditorStore((state) => {
    const source = selectNode(state.document, edge?.source ?? '');
    const target = selectNode(state.document, edge?.target ?? '');
    return source && target ? `${categoryOf(source)}>${categoryOf(target)}` : undefined;
  });
  const [sourceCategory, targetCategory] = (pairing?.split('>') ?? []) as [NodeCategory?, NodeCategory?];
  const relationshipStatus =
    sourceCategory && targetCategory ? capabilityFor(sourceCategory, targetCategory)?.status : undefined;
  const showSequence = useEditorStore((state) => state.document.settings.showSequence);
  // Playback, step badges and Focus are read as small per-edge primitives, not as the whole
  // `flows`/`flowPlayback`/`focus` objects: a step change then re-renders only the connectors whose
  // own tier actually flipped, instead of every connector on the canvas (same as `DraftNodeView`).
  const tier = useEditorStore((state) => explainTierForEdge(state, id));
  const playbackActive = useEditorStore((state) => state.flowPlayback.active);
  // Only the active connector can be in its response phase, so only it re-renders when that flips.
  const responsePhase = useEditorStore(
    (state) => state.flowPlayback.phase === 'response' && explainTierForEdge(state, id) === 'active',
  );
  const playingAccent = useEditorStore((state) => playingFlowOf(state)?.accent);
  const stepNumber = useEditorStore((state) =>
    state.selectedFlowId ? stepIndexOf(findFlow(state.document, state.selectedFlowId), id) : undefined,
  );
  const focusDimmed = useEditorStore((state) => {
    if (!state.focus.active) return false;
    const self = selectEdge(state.document, id);
    return self ? !isEdgeFocused(state.focus, self) : false;
  });
  // The flow object comes straight out of `document.flows`, so its identity only changes when the
  // flow itself does — this subscription doesn't re-render every edge on unrelated store writes.
  const lensFlowValue = useEditorStore(lensFlow);
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
  // Obstacle avoidance only ever looks at nodes overlapping the box between this connector's own
  // endpoints (see `obstaclesForEdge`), each as a rect that keeps its identity while its node is
  // untouched — so under `useShallow` a commit elsewhere on the canvas re-renders nothing here.
  // While a gesture moves nodes, a connector attached to one skips avoidance until it commits (its
  // route changes every frame anyway); every other connector keeps its detours, minus the moving
  // nodes' own stale rects. Both read `movingNodeIds` through selectors that settle to a boolean or
  // an unchanged list, so a gesture starting or ending re-renders only the connectors it touches —
  // not all of them because the set is a new object.
  const endpointMoving = useUiStore(
    (state) => edge !== undefined && (state.movingNodeIds.has(edge.source) || state.movingNodeIds.has(edge.target)),
  );
  const nearbyObstacles = useEditorStore(
    useShallow((state) =>
      endpointMoving || !edge ? NO_OBSTACLES : obstaclesForEdge(state.document.nodes, edge.source, edge.target),
    ),
  );
  const obstacles = useUiStore(useShallow((state) => withoutNodes(nearbyObstacles, state.movingNodeIds)));
  // Where this connector crosses another, and so draws a small arc over it. Safe to subscribe to
  // as an array for the same reason `spine` is safe as an object: the plan is memoized on the
  // (nodes, edges) pair and hands back a frozen, identity-stable list — the very same empty one
  // for every connector that crosses nothing, which is most of them.
  const planned = useEditorStore((state) => crossingPlan(state.document.nodes, state.document.edges).crossingsFor(id));
  // A gesture makes three kinds of crossing unreliable, and all three are dropped for its duration
  // rather than recomputed per frame: this connector's own endpoint moving, the crossed
  // connector's endpoint moving, and — the quiet one — this connector merely detouring around a
  // node that is moving, which reroutes it live while the plan still holds its committed route.
  // `withoutNodes` having shortened the obstacle list is exactly that third case, already measured.
  const routeUnsettled = endpointMoving || obstacles.length !== nearbyObstacles.length;
  // `withoutMoving` hands back a fresh array whenever it drops *some* of the crossings — the very
  // case of a connector hopping over two others when a shape on just one of them is picked up.
  // zustand 5 re-reads a selector to check it is stable, so an unguarded fresh array is an
  // infinite render loop that takes the whole canvas down; `useShallow` compares the crossings
  // themselves (identity-stable, straight out of the frozen plan) rather than the array holding them.
  const crossings = useUiStore(
    useShallow((state) => (routeUnsettled ? NO_CROSSINGS : withoutMoving(planned, state.movingNodeIds))),
  );
  // Connectors leaving together under one label draw it once, on the run they share — see
  // `edges/labelGroups.ts`. The group is identity-stable out of a memoized plan, like `spine`.
  const labelGroup = useEditorStore((state) => labelGroupPlan(state.document.nodes, state.document.edges).groupFor(id));
  // A numbered step rides inside each connector's own label chip, so while a flow's steps show, a
  // group whose members carry them keeps separate labels.
  const groupStepped = useEditorStore((state) => {
    if (!labelGroup || !state.document.settings.showSequence || !state.selectedFlowId) return false;
    const flow = findFlow(state.document, state.selectedFlowId);
    return labelGroup.members.some((member) => stepIndexOf(flow, member) !== undefined);
  });
  const sharedLabel = labelGroup && !groupStepped ? labelGroup : undefined;
  // Which member draws it — a string, so only the group's own members re-render when it moves.
  const sharedLabelLeader = useEditorStore((state) =>
    sharedLabel
      ? labelLeader(sharedLabel, {
          selectedEdges: state.selection.edges,
          tierOf: state.flowPlayback.active ? (member) => explainTierForEdge(state, member) : undefined,
        })
      : null,
  );
  const sourceType = useEditorStore((state) => selectNode(state.document, edge?.source ?? '')?.type);
  const targetType = useEditorStore((state) => selectNode(state.document, edge?.target ?? '')?.type);
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

  // Tracked in JS, not left to a pure `.dc-edge:hover` CSS rule: the response label and the
  // attachment chip row both live in React Flow's `EdgeLabels` portal, a sibling overlay div
  // elsewhere in the DOM tree, not real descendants of this `<g>` — so no ancestor-based CSS
  // selector can ever reach them, the same reason
  // `.dc-edge-label`'s own `data-active`/`data-dimmed`/etc. are passed as explicit props rather than
  // relied on to cascade from a parent. This one boolean covers both the response line (a real SVG
  // child, which *could* use plain `:hover`, but sharing one mechanism avoids two divergent ones)
  // and its portaled label.
  // Which connector that is comes from `canvas/edgePick.ts`, via the store, rather than from this
  // `<g>`'s own enter/leave: a node's handle ring in front of the line, or a neighbour's overlapping
  // hit path, used to take the pointer without this connector ever hearing of it.
  const hovering = useUiStore((state) => state.hoveredEdgeId === id);
  useEffect(
    () => () => {
      // A connector deleted (or undone away) under the pointer must not come back already hovered.
      if (useUiStore.getState().hoveredEdgeId === id) useUiStore.getState().setHoveredEdge(null);
    },
    [id],
  );

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
    // oxlint-disable-next-line react/set-state-in-effect -- one-shot external command, see comment above.
    if (mode !== 'present') setEditing(true);
  }, [editRequested, mode]);

  // Computed here, ahead of the early returns below, purely so the hooks
  // that follow (`lensPulsing`'s state/ref/effect) never run conditionally —
  // React requires the same hooks in the same order on every render, even
  // one where this edge (or a node it references) has just been deleted and
  // this component is about to render nothing. `edge` may still be
  // undefined at this point, hence the optional-chained guards throughout.
  const isActiveStep = playbackActive && tier === 'active';
  const isShownStep = playbackActive && tier === 'shown';
  const dimmed = playbackActive && tier === 'hidden';
  // Which of a request/response connector's two lines the active step's pulse animates — see
  // `FlowPlaybackState.phase`. Irrelevant, and always `'request'`, for a plain edge (no
  // `hasResponse`) or one not the active step, so existing single-line playback is entirely
  // unchanged.
  const pulseTarget: 'request' | 'response' =
    isActiveStep && edge?.hasResponse && responsePhase ? 'response' : 'request';

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
    isActiveStep && playingAccent ? accentOf(theme, playingAccent).chip : undefined;
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
    // Reset on cleanup too: a second lens switch inside the 650ms that no longer includes this
    // edge returns early above, so the timeout cancelled here would otherwise leave it pulsing.
    return () => {
      clearTimeout(timeout);
      setLensPulsing(false);
    };
  }, [lensFlowId, lensMember]);

  if (!edge || !sourceNode || !targetNode) return null;

  const sourceRect = rectOfInternal(sourceNode, sourceType);
  const targetRect = rectOfInternal(targetNode, targetType);
  if (!sourceRect || !targetRect) return null;

  // While an endpoint is being dragged, the path tracks the live pointer
  // position instead of the node it's still (until drop) actually attached
  // to — a degenerate zero-size rect at that point, which `anchorPoint`
  // already resolves to exactly that point regardless of side/offset. The
  // dragged end's persisted anchor is set aside too, so the route picks
  // whichever side reads best against the live point rather than fighting
  // to honour an anchor that's about to change anyway.
  const effectiveSourceRect = dragOverride?.endpoint === 'source' ? pointRect(dragOverride.point) : sourceRect;
  const effectiveTargetRect = dragOverride?.endpoint === 'target' ? pointRect(dragOverride.point) : targetRect;
  // Same rule as a moving endpoint node: a pointer-tracked end reroutes every frame, refine on drop.
  const routeObstacles = dragOverride ? NO_OBSTACLES : obstacles;

  // Every input the two routes read, as one key: a connector re-renders for selection, lens,
  // playback, and hover far more often than its geometry actually moves.
  const routeKey = JSON.stringify([
    effectiveSourceRect,
    effectiveTargetRect,
    edge.routing,
    edge.sourceAnchor,
    edge.targetAnchor,
    edge.hasResponse,
    laneOffset,
    dragOverride?.endpoint,
    spine,
    routeObstacles,
  ]);
  const routes = ROUTES.getOrCreate(routeKey, computeRoutes);
  function computeRoutes(): EdgeRoutes {
    const request = routeBetween(effectiveSourceRect, effectiveTargetRect, edge!.routing, {
      anchors: {
        source: dragOverride?.endpoint === 'source' ? undefined : edge!.sourceAnchor,
        target: dragOverride?.endpoint === 'target' ? undefined : edge!.targetAnchor,
      },
      lane: laneOffset,
      obstacles: routeObstacles,
      // An endpoint being dragged is on its way out of this bundle — keeping it
      // on the trunk would rubber-band it back to a group it is leaving.
      spine: dragOverride ? undefined : spine,
    });
    // The reply half of a request/response connector — see `responseRoute` below.
    const response = edge!.hasResponse
      ? routeBetween(effectiveTargetRect, effectiveSourceRect, edge!.routing, {
          anchors: {
            source: dragOverride?.endpoint === 'target' ? undefined : edge!.targetAnchor,
            target: dragOverride?.endpoint === 'source' ? undefined : edge!.sourceAnchor,
          },
          lane: responseLaneFor(laneOffset),
          obstacles: routeObstacles,
          spine: dragOverride ? undefined : responseSpineFor(spine),
        })
      : null;
    return { request, response };
  }
  const route = routes.request;
  // A label chip is far taller than the line's own lane nudge — extra
  // separation on top of it is what keeps parallel labels from stacking.
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, laneOffset);
  const labelX = route.labelX + labelNudge.x;
  const labelY = route.labelY + labelNudge.y;
  const attachmentFlipBelow = attachmentRowBelowsSourceOrTarget(labelX, labelY, sourceRect, targetRect, captionSideOf(edge, route.labelSide));

  const hasLabel = Boolean(edge.label);
  // In a label group, the leader draws the one label at the group's point — along its own live line
  // while a gesture reroutes it, so the label rides the line instead of waiting for the drop — and
  // every other member draws none (unless it is the one being edited).
  const drawsSharedLabel = sharedLabel !== undefined && sharedLabelLeader === id;
  const hidesOwnLabel = sharedLabel !== undefined && !drawsSharedLabel && !editing;
  const sharedAt = drawsSharedLabel || (sharedLabel !== undefined && editing)
    ? routeUnsettled || dragOverride
      ? (pointAlong(route.d, sharedLabel!.distance) ?? sharedLabel!)
      : sharedLabel!
    : null;
  const chipSide = sharedAt ? sharedLabel!.side : route.labelSide;
  const chipX = sharedAt ? sharedAt.x : labelX;
  const chipY = sharedAt ? sharedAt.y : labelY;
  const labelLayout = edge.label ? layoutEdgeLabel(edge.label) : null;
  const responseLayout = edge.response ? layoutEdgeResponse(edge.response) : null;
  const hasStep = showSequence && typeof stepNumber === 'number';
  // The very point the exporter puts it at — one function, so the two can't drift apart.
  const badgeAt = hasStep ? badgePoint(route, edge.routing) : null;
  // A bundle's members all share one relationship, so repeating its caption down every branch is
  // the exact "calls / calls / calls" column Smart Routing exists to remove: every member draws it
  // at the same point on the shared stem instead, where the identical copies overdraw into one
  // label. An architecturally unusual pairing keeps its own caption on its own branch — that
  // warning is about this relationship, not its siblings. Mirrors `edges/describe.ts`.
  const captionIsUnusual = relationshipStatus === 'unusual' || relationshipStatus === 'questionable';
  const captionCollapsed = Boolean(route.trunkLabel) && !captionIsUnusual;
  const captionAt = captionCollapsed ? route.trunkLabel! : { x: labelX, y: labelY };
  // Being a numbered step must never cost a connector its words — only the step badge physically
  // landing on them may, which is a question about two points and nothing else (`badgeCrowds`).
  // The glyphs below sit at the midpoint whatever the bundle does; only the caption follows the
  // trunk, so the two are measured separately.
  const badgeOverCaption = badgeAt !== null && badgeCrowds(badgeAt, captionAt);
  const badgeOverMidpoint = badgeAt !== null && badgeCrowds(badgeAt, { x: labelX, y: labelY });
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
  // Crossing bridges go on *after* the wobble, never before. `roughenPath` jitters by point
  // ordinal, so inserting an arc's points first would change the wobble of everything downstream
  // of it — the whole line would visibly re-settle whenever an unrelated crossing appeared, and a
  // bundle's members would each wobble the shared trunk differently, which is exactly what
  // `strokeSeed` exists to prevent. Going on afterwards leaves the wobble byte-identical.
  const drawnPath = bridgePath(roughenPath(route.d, `${seed}:0`, profile.outline, profile.bow), crossings);
  const secondStrokePath =
    profile.strokes === 2
      ? bridgePath(roughenPath(route.d, `${seed}:1`, profile.outline, profile.bow), crossings)
      : null;
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
  const responseRoute = routes.response;
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
  const responseRevealed = selected || hovering || pulseTarget === 'response';
  // The hover emphasis itself is an editing affordance — "click to select this" — so Present, where
  // nothing is selected, keeps only the reveals above.
  const hoverShown = hovering && !selected && mode === 'edit';

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
      data-hovered={hoverShown ? 'true' : undefined}
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
      {/* A real stroke, fully transparent — not `stroke: none`. `pointer-events: visibleStroke` hits a
          stroke of none just the same, but Chrome culls hit-testing to the shape's bounding box, and
          without a stroke that box is the bare geometry: a straight connector's box has no height at
          all, and a bent one's stops at its outermost run, so half of the band past it was dead. */}
      <path
        className="dc-edge-hit react-flow__edge-interaction"
        d={route.d}
        fill="none"
        stroke="#000"
        strokeOpacity={0}
        strokeWidth={12}
      />
      {/* The reply line is part of the same connector, and as clickable as the request line. */}
      {responseRoute && (
        <path
          className="dc-edge-hit react-flow__edge-interaction"
          d={responseRoute.d}
          fill="none"
          stroke="#000"
          strokeOpacity={0}
          strokeWidth={12}
        />
      )}
      {/* Hover, not selection: a faint wash of the selection colour under the line, so "this is the
          one a click takes" reads without looking selected. Mounted only while hovered — canvas
          chrome, never exported (`edges/describe.ts` has no counterpart, deliberately). */}
      {hoverShown && (
        <path className="dc-edge-hover" d={drawnPath} fill="none" pointerEvents="none" stroke={theme.selection} strokeLinecap="round" />
      )}
      <path
        className="react-flow__edge-path dc-edge-line"
        d={drawnPath}
        fill="none"
        pointerEvents="none"
        markerEnd={edge.directed && !usesHandDrawnArrow ? markerRef(strokeColor, markerVariantForEdge(edge)) : undefined}
        style={{
          stroke: strokeColor,
          strokeWidth: isActiveStep ? 2.6 : selected || attachTarget ? 2.4 : lensMember ? 2.0 : hoverShown ? 2.0 : 1.6,
          strokeLinecap: 'round',
          strokeDasharray: dashForEdge(edge)?.join(' '),
        }}
      />
      {secondStrokePath && (
        <path
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

      {/* Where a dropped Note/Code will actually land: this connector's own label point, the
          same one its chip row hangs from below. Mounted only while this connector is the armed
          target of a drag, so a connector carries no extra mark the rest of the time. Drag chrome,
          like the selection ring — deliberately not mirrored into `edges/describe.ts`, because it
          must never reach an exported image. */}
      {attachTarget && (
        <circle
          className="dc-edge-landing"
          cx={labelX}
          cy={labelY}
          r={3.5}
          fill={theme.selection}
          // Punched out of the line rather than drawn on top of it — the dot sits on a connector
          // already tinted with the selection colour, and without this it reads as a thickening of
          // the stroke instead of as a point on it.
          stroke={theme.canvas}
          strokeWidth={1.5}
        />
      )}

      {/* A small glyph at the path's midpoint — see the matching comment in
          `edges/describe.ts`. Only when nothing else already occupies that spot. */}
      {!hasLabel && !badgeOverMidpoint && edge.kind === 'event' && (
        <circle cx={labelX} cy={labelY} r={3} fill={strokeColor} />
      )}
      {!hasLabel && !badgeOverMidpoint && edge.kind === 'conditional' && (
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
          no visible text at all. `captionAnchor`'s `responseAway` flag is what keeps this from
          landing on top of the response line's own label — see its own doc comment. */}
      {!hasLabel && !badgeOverCaption && edge.semantic && (() => {
        const captionSide = captionCollapsed ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide;
        const caption = captionAnchor(captionSide, captionAt.x, captionAt.y, edge.hasResponse ? Math.sign(responseLane) : 0);
        const label = relationshipCaptionLabel(edge.semantic, {
          hasResponse: edge.hasResponse,
          deliveryAttempts: edge.deliveryAttempts,
          source: sourceCategory,
          target: targetCategory,
        });
        return (
          <text
            className="dc-edge-caption"
            x={caption.x}
            y={caption.y}
            textAnchor={caption.textAnchor}
            dominantBaseline={caption.dominantBaseline}
            fill={captionIsUnusual ? theme.accents.amber.text : theme.textFaint}
            style={{ font: cssFont(FONTS.connectorCaption) }}
          >
            {captionIsUnusual ? `▲ ${label}` : label}
          </text>
        );
      })()}

      <EdgeLabels>
        {/* `display: contents` — no box of its own, so every chip below still positions against the
            label layer. It only tells `edgePick.ts` whose chip the pointer is on. */}
        <div className="dc-edge-overlay" data-edge-overlay={edge.id}>
        {/* Where this connector starts and ends, hinted while it is hovered: the same dots selecting it
            makes draggable, smaller and hollow, and not yet anything to grab. */}
        {hoverShown && (
          <>
            <div className="dc-edge-endpoint-hint" style={{ transform: `translate(-50%, -50%) translate(${route.source.x}px, ${route.source.y}px)` }} />
            <div className="dc-edge-endpoint-hint" style={{ transform: `translate(-50%, -50%) translate(${route.target.x}px, ${route.target.y}px)` }} />
          </>
        )}
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
              oppositeNodeId={edge.target}
              onDrag={setDragOverride}
            />
            <EdgeEndpointHandle
              edgeId={edge.id}
              endpoint="target"
              x={route.target.x}
              y={route.target.y}
              oppositeNodeId={edge.source}
              onDrag={setDragOverride}
            />
          </>
        )}

        {(hasLabel || editing) && !hidesOwnLabel && (
          <div
            className="dc-edge-label"
            data-editing={editing ? 'true' : undefined}
            // Named for `edgePick.ts`: a click on a label several connectors share steps through them.
            data-label-group={drawsSharedLabel ? sharedLabel!.members.join(' ') : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-active={isActiveStep ? 'true' : undefined}
            data-lens-dimmed={lensDimmed ? 'true' : undefined}
            style={{ transform: labelChipTransform(chipSide, chipX, chipY) }}
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
                aria-label="Connector label"
                className="dc-edge-label-input"
                defaultValue={edge.label ?? ''}
                spellCheck={false}
                onBlur={(event) => {
                  updateEdgeLabel(edge.id, event.currentTarget.value.trim());
                  stopEditing();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (isImeKeyEvent(event)) return;
                  if (event.key === 'Enter') {
                    updateEdgeLabel(edge.id, event.currentTarget.value.trim());
                    stopEditing();
                  }
                  if (event.key === 'Escape') stopEditing();
                }}
              />
            ) : (
              // The same lines the exporter draws (`layoutEdgeLabel`): wrapped at 220 units, two
              // lines at most, then an ellipsis — with the whole label in the tooltip.
              <span
                className="dc-edge-label-text"
                title={
                  drawsSharedLabel && mode === 'edit'
                    ? `${labelLayout?.truncated ? `${edge.label} — ` : ''}Shared by ${sharedLabel!.members.length} connectors. Click again for the next one.`
                    : labelLayout?.truncated
                      ? edge.label
                      : undefined
                }
              >
                {labelLayout?.lines.map((line, index) => (
                  <span key={index} className="dc-edge-label-line">
                    {line.text}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}

        {/*
          A standalone badge only when there is no label to carry it. On a short
          connector the two would otherwise sit on top of each other.

          `hidesOwnLabel` is the exception: a follower in a label group draws no chip of its own
          (the group's leader draws the one label for all of them), so there is nothing to carry
          its number and without this its step is invisible on screen — while `edges/describe.ts`
          drew it anyway, which is exactly the silent drift the two-renderer split risks.
        */}
        {hasStep && (!hasLabel || hidesOwnLabel) && !editing && (
          <div
            className="dc-edge-step"
            data-active={isActiveStep ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-lens-dimmed={lensDimmed ? 'true' : undefined}
            style={{
              transform: `translate(-50%, -50%) translate(${badgeAt?.x ?? 0}px, ${badgeAt?.y ?? 0}px)`,
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
                    if (isImeKeyEvent(event)) return;
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
            <span className="dc-edge-label-line" title={responseLayout?.truncated ? edge.response : undefined}>
              {responseLayout?.lines[0]?.text}
            </span>
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
            explainTier={playbackActive ? tier : undefined}
            revealed={selected || hovering}
            style={{ position: 'absolute', transform: attachmentRowTransform(labelX, labelY, attachmentFlipBelow) }}
          />
        ) : null}
        </div>
      </EdgeLabels>
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
  oppositeNodeId,
  onDrag,
}: {
  edgeId: string;
  endpoint: 'source' | 'target';
  x: number;
  y: number;
  /** The other end's node — never a drop target, since `reconnectEdge` refuses a self-loop. */
  oppositeNodeId: string;
  onDrag: (override: DragOverride | null) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  // Only a selected connector mounts these handles, so this whole-array subscription is paid by
  // at most two components — never by every connector on the canvas.
  const nodes = useEditorStore((state) => state.document.nodes);
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
  /** The pointer driving the drag. A second finger landing mid-drag (to pinch, say) is ignored
   *  rather than restarting the gesture from where it touched. */
  const activePointer = useRef<number | null>(null);

  // A single pass tracking the highest-z match is equivalent to (and cheaper
  // than) copying + sorting the whole array on every pointer-move frame of a
  // reconnect drag — same result, no allocation, no O(n log n) sort.
  const findDropNode = useCallback(
    (point: { x: number; y: number }) => {
      let best: DraftNode | undefined;
      for (const node of nodes) {
        if (node.type === 'group' || node.id === oppositeNodeId) continue;
        if (!pointInBox(point, node)) continue;
        if (!best || node.z > best.z) best = node;
      }
      return best;
    },
    [nodes, oppositeNodeId],
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
    activePointer.current = null;
    onDrag(null);
  }, [onDrag]);

  // `endDrag` already runs on a normal pointer-up/Escape, but if the component unmounts mid-drag
  // — this edge is deleted while its endpoint is being dragged, or `mode` flips to `'present'`
  // (which un-renders this handle entirely) — that path never runs. Without also resetting the
  // shared `uiStore` fields here, `interactionActive` is left stuck `true`, which silently
  // freezes every open popover's placement and suppresses continuation offers until an unrelated
  // gesture happens to flip it back off. `endDrag` is written to be idempotent
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
      // Only the primary button repoints — a right-click here is a context-menu gesture, not a drag.
      if (event.button !== 0 || activePointer.current !== null) return;
      activePointer.current = event.pointerId;
      cancelled.current = false;
      dragStarted.current = false;
      startClient.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      // A second pointer landing mid-drag (multi-touch) must not orphan the first Escape listener.
      if (onKeyDownRef.current) window.removeEventListener('keydown', onKeyDownRef.current);
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
      if (cancelled.current || event.pointerId !== activePointer.current) return;
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
      if (event.pointerId !== activePointer.current) return;
      const wasCancelled = cancelled.current;
      const didDrag = dragStarted.current;
      // Ended before capture is released, so the `lostpointercapture` that follows finds no drag.
      endDrag();
      event.currentTarget.releasePointerCapture(event.pointerId);
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
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerId !== activePointer.current) return;
      cancelled.current = true;
      endDrag();
    },
    [endDrag],
  );

  return (
    <div
      className="dc-edge-endpoint"
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // Capture lost some other way (the element re-rendered away from under it, a system gesture)
      // gets no pointer-up: without this the preview and reconnect flags would stay stuck.
      onLostPointerCapture={onPointerCancel}
    />
  );
}

/** The flow being presented, if any. */
function playingFlowOf(state: EditorStore) {
  const { active, flowId } = state.flowPlayback;
  return active && flowId ? findFlow(state.document, flowId) : undefined;
}

/** This connector's Presentation tier — a string, so only connectors whose tier flips re-render. */
function explainTierForEdge(state: EditorStore, id: string): ExplainTier {
  const flow = playingFlowOf(state);
  return flow ? edgeTierAt(flow, id, state.flowPlayback.step) : 'hidden';
}
