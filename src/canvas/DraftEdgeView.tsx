import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps } from '@xyflow/react';
import type { Attachment, DraftEdge, DraftNode } from '../document/types';
import { explainEdgeTier, lensEdgeTier, stepIndexOf } from '../document/flow';
import { markerRef } from '../render/svg/markers';
import {
  LABEL_LINE_GAP,
  labelLaneOffset,
  laneIndex,
  rectOf,
  responseLaneFor,
  routeBetween,
  snappedAnchorForDrop,
  type Rect,
  type Side,
} from '../edges/routing';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge, resolveEdgeColor } from '../edges/kindStyle';
import { attachmentRowBelowsSourceOrTarget, rectOfInternal } from './edgeGeometry';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import { NOTE_ACCENTS, NOTE_LABELS } from '../nodes/describe';
import { LANGUAGE_LABELS, tokenizeCode } from '../render/code/highlight';
import { CODE_THEMES, colorForScope } from '../render/code/theme';
import { PRESET_AMPLITUDE } from '../render/roughness/presets';
import { roughenPath } from '../render/roughness/roughPath';
import { accentOf, type Theme } from '../render/theme/tokens';
import { isEdgeFocused, useEditorStore } from '../store/editorStore';
import { selectEdge, selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useTheme, useThemeValue } from '../ui/theme/useTheme';
import { Icon } from '../ui/common/Icon';
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

/**
 * The same line-clearance idea as `labelChipTransform`, for the plain SVG `<text>` caption: a
 * fixed downward offset (the pre-existing behaviour) already clears a horizontal line just fine,
 * since it moves the text off the line's own y-coordinate — the vertical-line case is the one that
 * was never actually clear (a y-only offset leaves the text centered right back on the line's x).
 */
function captionAnchor(
  side: Side,
  x: number,
  y: number,
): { x: number; y: number; textAnchor: 'start' | 'middle' | 'end'; dominantBaseline?: 'middle' } {
  if (side === 'right') return { x: x + LABEL_LINE_GAP, y, textAnchor: 'start', dominantBaseline: 'middle' };
  if (side === 'left') return { x: x - LABEL_LINE_GAP, y, textAnchor: 'end', dominantBaseline: 'middle' };
  return { x, y: y + 14, textAnchor: 'middle' };
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
  const showSequence = useEditorStore((state) => state.document.settings.showSequence);
  const flows = useEditorStore((state) => state.document.flows);
  const flowPlayback = useEditorStore((state) => state.flowPlayback);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const focus = useEditorStore((state) => state.focus);
  const mode = useEditorStore((state) => state.mode);
  const updateEdgeLabel = useEditorStore((state) => state.updateEdgeLabel);
  const theme = useThemeValue();
  const { preset } = usePersonality();

  // A primitive, not the `LaneAssignment` object — see `laneIndex`'s comment.
  // Only the edges whose own lane actually shifts re-render when a sibling
  // connector is added or removed between the same two nodes.
  const laneOffset = useEditorStore((state) => laneIndex(state.document.edges).get(id)?.offset ?? 0);
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
  const editRequested = useUiStore((state) => state.editRequestId === id);

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
  // `explainEdgeTier` above, not a degenerate case of it. Suppressed while
  // Presentation or Focus already own the dimming.
  const lensActive = Boolean(overlayFlow) && !flowPlayback.active && !focus.active;
  const lensTier = lensActive && edge ? lensEdgeTier(overlayFlow, edge.id) : 'dimmed';
  const lensMember = lensActive && lensTier === 'member';
  const lensDimmed = lensActive && lensTier === 'dimmed';
  // The flow's own identity colour, temporarily worn by its member
  // connectors while it's the active lens — never a permanent per-edge
  // colour, since a connector can belong to several flows. See
  // `DraftFlow.accent`.
  const lensAccent = lensMember && overlayFlow?.accent ? accentOf(theme, overlayFlow.accent).chip : undefined;
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
  const prevSelectedFlowRef = useRef(selectedFlowId);
  useEffect(() => {
    // The `switched` guard, not the dependency array, is what actually
    // decides whether to pulse — so listing `lensMember` here only means the
    // effect also runs (and immediately no-ops) when it flips on its own
    // (e.g. presenting starts/stops) without `selectedFlowId` changing.
    const switched = prevSelectedFlowRef.current !== selectedFlowId;
    prevSelectedFlowRef.current = selectedFlowId;
    if (!switched || !lensMember) return;
    setLensPulsing(true);
    const timeout = setTimeout(() => setLensPulsing(false), 650);
    return () => clearTimeout(timeout);
  }, [selectedFlowId, lensMember]);

  if (!edge || !sourceNode || !targetNode) return null;

  const sourceRect = rectOfInternal(sourceNode);
  const targetRect = rectOfInternal(targetNode);
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
  });
  // A label chip is far taller than the line's own lane nudge — extra
  // separation on top of it is what keeps parallel labels from stacking.
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, laneOffset);
  const labelX = route.labelX + labelNudge.x;
  const labelY = route.labelY + labelNudge.y;

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
  // route, matching `edges/describe.ts`'s dual-renderer contract. The
  // amplitude is small enough relative to `interactionWidth` below that
  // hit-testing (which necessarily follows whichever path `BaseEdge` draws)
  // stays effectively unaffected.
  const roughAmplitude = PRESET_AMPLITUDE[preset];
  const drawnPath =
    roughAmplitude.outline === 0 ? route.d : roughenPath(route.d, `${edge.id}:0`, roughAmplitude.outline);
  const secondStrokePath =
    roughAmplitude.strokes === 2 ? roughenPath(route.d, `${edge.id}:1`, roughAmplitude.outline) : null;

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
      })
    : null;
  const responseDrawnPath = responseRoute
    ? roughAmplitude.outline === 0
      ? responseRoute.d
      : roughenPath(responseRoute.d, `${edge.id}:response`, roughAmplitude.outline)
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
      data-lens-dimmed={lensDimmed ? 'true' : undefined}
      data-lens-pulse={lensPulsing ? 'true' : undefined}
      onPointerEnter={responseRoute ? () => setHoveringResponse(true) : undefined}
      onPointerLeave={responseRoute ? () => setHoveringResponse(false) : undefined}
    >
{/*
        `BaseEdge` draws the path and, through `interactionWidth`, a second
        invisible one wide enough to click. Hand-rolling that stroke is not
        enough: React Flow keys selection off its own interaction path.
      */}
      <BaseEdge
        className="dc-edge-line"
        path={drawnPath}
        markerEnd={edge.directed ? markerRef(strokeColor, markerVariantForEdge(edge)) : undefined}
        interactionWidth={18}
        style={{
          stroke: strokeColor,
          strokeWidth: isActiveStep ? 2.6 : selected || attachTarget ? 2.4 : 1.6,
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
      {responseDrawnPath && (
        <path
          className="dc-edge-response-line"
          data-revealed={responseRevealed ? 'true' : undefined}
          d={responseDrawnPath}
          fill="none"
          markerEnd={edge.directed ? markerRef(strokeColor, 'open') : undefined}
          style={{
            stroke: strokeColor,
            strokeWidth: 1,
            strokeLinecap: 'round',
            strokeDasharray: RESPONSE_DASH.join(' '),
          }}
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
      {/* A subtle caption of the relationship — independent of `kind`'s glyph
          above, so a plain call/read/write connector reads just as clearly as
          an event one. Yields entirely to a real label the moment there is one,
          and to a request/response connector's own reply line: its fixed
          downward offset would otherwise land right on top of (or read as
          attached to) the quiet response line/label below, and the two-line
          shape itself already communicates "this is a call" without the
          caption's help. */}
      {!hasLabel && !hasStep && !edge.hasResponse && edge.semantic && (() => {
        const caption = captionAnchor(route.labelSide, labelX, labelY);
        return (
          <text
            x={caption.x}
            y={caption.y}
            textAnchor={caption.textAnchor}
            dominantBaseline={caption.dominantBaseline}
            fill={theme.textFaint}
            style={{ font: cssFont(FONTS.connectorCaption) }}
          >
            {SEMANTIC_DEFAULTS[edge.semantic].label}
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
            <span className="dc-edge-condition" style={{ color }}>
              {conditionText}
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
          <EdgeAttachmentRow
            edge={edge}
            x={labelX}
            y={labelY}
            flipBelow={attachmentRowBelowsSourceOrTarget(labelX, labelY, sourceRect, targetRect)}
            editable={mode !== 'present'}
          />
        ) : null}
      </EdgeLabelRenderer>
    </g>
  );
});

/** Must match the `dc-attachment-card-in`/`-out` keyframe duration in `canvas.css` — the card
 *  stays mounted this long after `visible` goes false so the CSS fade-out has time to play
 *  instead of the DOM node just vanishing mid-animation. */
const ATTACHMENT_CARD_EXIT_MS = 120;

/**
 * Read-only, syntax-highlighted code — the same `tokenizeCode`/`colorForScope` primitives
 * `FlowBar.tsx`'s `DetailPanel` uses for a connection's legacy `details` field during playback,
 * reused here rather than duplicated. Not imported from there directly: `ui/Editor/FlowBar.tsx`
 * sits above `canvas/` in this app's one-way dependency order, so this is its own small instance
 * of the same pattern, not a shared component.
 */
function ReadOnlyCode({ language, code }: { language: Parameters<typeof tokenizeCode>[1]; code: string }) {
  const { name } = useTheme();
  const codeTheme = CODE_THEMES[name];
  const lines = tokenizeCode(code, language);
  return (
    <pre className="dc-edge-attachment-code">
      <code>
        {lines.map((line, index) => (
          <span className="dc-code-line" key={index}>
            {line.length === 0
              ? '\n'
              : line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={{ color: colorForScope(codeTheme, token.scope) }}>
                    {token.text}
                  </span>
                ))}
            {line.length > 0 && '\n'}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** What a chip/card looks like for one attachment — matches the corresponding card type's own
 *  real styling exactly (`nodes/describe.ts`'s `note`/`codeCard`), rather than a generic box, so
 *  a Note attachment reads as a note and a Code one reads as code. */
interface AttachmentLook {
  fill: string;
  border: string;
  accent: string;
  headerBg?: string;
  label: string;
}

function attachmentLookFor(theme: Theme, attachment: Attachment): AttachmentLook {
  if (attachment.type === 'code') {
    const language = attachment.language ?? 'plaintext';
    return {
      fill: theme.codeBg,
      border: theme.codeBorder,
      accent: theme.textFaint,
      headerBg: theme.surfaceRaised,
      label: LANGUAGE_LABELS[language],
    };
  }
  const kind = attachment.noteKind ?? 'note';
  const palette = accentOf(theme, attachment.accent ?? NOTE_ACCENTS[kind]);
  return { fill: palette.fill, border: palette.line, accent: palette.chip, label: NOTE_LABELS[kind] };
}

/**
 * The row of small chips floating above (or, if that would land on the connector's own source/
 * target node, below) its label point — one chip per attachment, each independently clickable, so
 * several attachments sit side by side rather than competing for one card.
 */
function EdgeAttachmentRow({
  edge,
  x,
  y,
  flipBelow,
  editable,
}: {
  edge: DraftEdge;
  x: number;
  y: number;
  flipBelow: boolean;
  editable: boolean;
}) {
  const attachments = edge.attachments;
  if (!attachments?.length) return null;
  return (
    <div
      className="dc-edge-attachment-row"
      data-flip={flipBelow ? 'below' : undefined}
      style={{ transform: attachmentRowTransform(x, y, flipBelow) }}
    >
      {attachments.map((attachment) => (
        <EdgeAttachmentChip key={attachment.id} edge={edge} attachment={attachment} editable={editable} />
      ))}
    </div>
  );
}

/**
 * One attachment's chip and its own floating card. The card is a plain CSS-positioned child of
 * the chip (not placed via flow coordinates like the row itself) — `top`/`bottom` off the chip's
 * own box, flipped by `.dc-edge-attachment-row[data-flip]` in `canvas.css` — which is what keeps
 * every card opening away from the connector's line regardless of how many chips sit beside it.
 *
 * Visible when `pinned || revealed` — a deliberate, purely per-attachment click reveal, not hover
 * and not selection: a card popping open just from resting the pointer nearby (or from every
 * attachment on the edge showing at once just because the edge itself got selected) read as noisy
 * on a diagram with several attachments. Each chip is independently keyboard-reachable
 * (`role="button" tabIndex={0}`, Enter/Space activates it) so dropping the old selection-reveals-
 * everything shortcut doesn't cost keyboard access. Pinning (`uiStore`'s `openEdgeDetail`, naming
 * both the edge and this specific attachment) is the only state that enables editing — and even
 * then, only once the pencil glyph is clicked (see `editing`, below); opening a card first always
 * shows it read-only, only when `editable` (i.e. not presenting) does the pencil glyph appear at
 * all. Presenting instead sets `presentationReveal`, always read-only, cleared automatically on
 * the next step.
 */
function EdgeAttachmentChip({
  edge,
  attachment,
  editable,
}: {
  edge: DraftEdge;
  attachment: Attachment;
  editable: boolean;
}) {
  const theme = useThemeValue();
  const look = attachmentLookFor(theme, attachment);
  const pinned = useUiStore(
    (state) => state.openEdgeDetail?.edgeId === edge.id && state.openEdgeDetail?.attachmentId === attachment.id,
  );
  const revealed = useUiStore(
    (state) =>
      state.presentationReveal?.edgeId === edge.id && state.presentationReveal?.attachmentId === attachment.id,
  );
  const setOpenEdgeDetail = useUiStore((state) => state.setOpenEdgeDetail);
  const setPresentationReveal = useUiStore((state) => state.setPresentationReveal);
  const updateEdgeAttachment = useEditorStore((state) => state.updateEdgeAttachment);
  const removeEdgeAttachment = useEditorStore((state) => state.removeEdgeAttachment);

  // Spans the whole chip (icon, label, and — once open — the card itself),
  // not just the card: see the outside-pointerdown effect below for why.
  const chipRef = useRef<HTMLDivElement>(null);

  // The textarea is uncontrolled (`defaultValue`) for smooth typing, but its live value must
  // survive whatever closes the card — Escape, a click anywhere outside, or the chip itself.
  // None of those reliably fire the textarea's own `blur` before React unmounts it: verified in
  // the browser that both Escape and an outside click discarded an in-progress edit, because the
  // state update that closes the card and the DOM removal happen before any native blur/focusout
  // has a chance to reach a still-live listener. So the live value is tracked here in a ref via
  // `onChange` (cheap — updates a ref, not state, no re-render) and committed by this effect on
  // the transition from pinned to not-pinned, regardless of *what* caused it — decoupled entirely
  // from focus/blur timing.
  const pendingValueRef = useRef<string | null>(null);
  const wasPinned = useRef(pinned);
  useEffect(() => {
    if (wasPinned.current && !pinned) {
      const pending = pendingValueRef.current;
      if (pending !== null) {
        const field = attachment.type === 'code' ? 'code' : 'text';
        const current = attachment.type === 'code' ? attachment.code ?? '' : attachment.text ?? '';
        if (pending !== current) updateEdgeAttachment(edge.id, attachment.id, { [field]: pending });
      }
      pendingValueRef.current = null;
    }
    wasPinned.current = pinned;
  }, [pinned, attachment, edge.id, updateEdgeAttachment]);

  // A click on the chip reveals the card read-only first — the earlier "click opens straight into
  // an editable textarea, cursor already blinking" behavior read as the card silently rewriting
  // itself out from under a click that was only meant to view it. Editing is now a deliberate
  // second step (the pencil glyph in the header), and always resets shut the moment the card
  // itself closes, so re-opening a pinned attachment never resumes mid-edit by surprise.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!pinned) setEditing(false);
  }, [pinned]);

  // Same precedent as `AttachmentPopover`: a capture-phase Escape (so it preempts
  // `EditorScreen`'s own bubble-phase chain), plus a click anywhere outside the chip closes it —
  // registered a tick late so the very click that opened the card doesn't immediately close it.
  // Covers both edit-mode pinning and a presenter's own reveal — whichever is active.
  //
  // Checked against the *whole chip* (`chipRef`), not just the card: a pointerdown on the chip's
  // own icon/label is "outside the card" too, so checking only `cardRef` used to close it here on
  // `pointerdown` — then the chip's own `onClick` (which fires after, on `pointerup`) reopened it
  // a moment later using its `pinned` closure from *before* this handler's update landed, netting
  // a no-op. Re-clicking the chip to close it is `onClick`'s job alone; this handler only needs to
  // catch a click genuinely outside the chip altogether (the pane, another chip, and so on).
  useEffect(() => {
    if (!pinned && !revealed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (pinned) setOpenEdgeDetail(null);
      if (revealed) setPresentationReveal(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (chipRef.current && !chipRef.current.contains(event.target as Node)) {
        if (pinned) setOpenEdgeDetail(null);
        if (revealed) setPresentationReveal(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [pinned, revealed, setOpenEdgeDetail, setPresentationReveal]);

  const visible = pinned || revealed;
  const kind = attachment.type === 'code' ? 'code' : 'note';

  // The card's own reveal animation is a CSS `animation` on mount, but hiding it is not the
  // mirror image of that: React would otherwise remove the DOM node the instant `visible` goes
  // false, cutting off any fade-out mid-frame. So the node stays mounted for one more tick,
  // marked `data-closing`, so `canvas.css` can play the reverse animation before it's gone.
  const [cardMounted, setCardMounted] = useState(visible);
  const [cardClosing, setCardClosing] = useState(false);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (visible) {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setCardClosing(false);
      setCardMounted(true);
      return;
    }
    if (!cardMounted) return;
    setCardClosing(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hideTimer.current = window.setTimeout(
      () => {
        setCardMounted(false);
        setCardClosing(false);
        hideTimer.current = null;
      },
      reduceMotion ? 0 : ATTACHMENT_CARD_EXIT_MS,
    );
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    // cardMounted intentionally excluded: it's only ever flipped by this effect's own timeout, so
    // reacting to it here would just re-run the same branch redundantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const togglePin = () => {
    // Not presenting: a click pins the card open for editing — the existing
    // edit-mode behavior, unchanged.
    if (editable) {
      setOpenEdgeDetail(pinned ? null : { edgeId: edge.id, attachmentId: attachment.id });
      return;
    }
    // Presenting: a click intentionally reveals the card read-only instead —
    // the presenter's own call on when extra context is useful, not an
    // automatic reveal. Auto-collapses on the next step change (`FlowBar.tsx`),
    // never unlocks the textarea below (that stays gated on `pinned`, which
    // presentation never sets).
    setPresentationReveal(revealed ? null : { edgeId: edge.id, attachmentId: attachment.id });
  };

  const chipVars = {
    ['--dc-chip-fill']: look.fill,
    ['--dc-chip-border']: look.border,
    ['--dc-chip-accent']: look.accent,
  } as CSSProperties;

  return (
    <div
      ref={chipRef}
      className="dc-edge-attachment-chip"
      data-kind={kind}
      // Suppresses the chip's own hover-pop while its card is showing — the card is a DOM child of
      // this chip, so without this, the chip's `:hover` scale (which reverts the instant the
      // pointer leaves, ~90ms) and the card's own open/close fade (a separate 120ms animation) run
      // as two independent, unsynchronized transforms on nested elements — the chip visibly
      // "un-pops" while the card is still lingering open, then the card fades out separately on its
      // own schedule. Reads as one unexplained extra zoom. See
      // `.dc-edge-attachment-chip:hover:not([data-open])` in `canvas.css`.
      data-open={cardMounted ? 'true' : undefined}
      role="button"
      tabIndex={0}
      title={
        pinned || revealed
          ? 'Close attached detail'
          : kind === 'code'
            ? 'View attached code'
            : 'View attached note'
      }
      // Set explicitly rather than left to default content-based computation: the card (with its
      // own, possibly lengthy, note/code content) is a DOM child of this chip for simple
      // CSS-relative positioning, and without this, that content would bleed into the chip's own
      // accessible name whenever it's open.
      aria-label={
        pinned || revealed
          ? 'Close attached detail'
          : kind === 'code'
            ? 'View attached code'
            : 'View attached note'
      }
      style={chipVars}
      onClick={(event) => {
        // The card (edit/delete glyphs, textarea) is a DOM child of this chip, so a click anywhere
        // inside it bubbles up here too — only clicks that did *not* originate inside the card
        // should toggle pin. Checking the card specifically (not `target === currentTarget`)
        // matters: a real click on the chip's own icon/label spans also has to work, and those
        // are non-card descendants of this same div. Still stopping propagation either way: without
        // it, a click on the edit/delete glyph kept bubbling past this handler's early return and
        // selected the underlying connector, popping the connector's own popover open behind the
        // card that was just opened to look at (or edit) one attachment.
        if ((event.target as HTMLElement).closest('.dc-edge-attachment-card')) {
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        togglePin();
      }}
      onKeyDown={(event) => {
        // Same reasoning as onClick above: without this guard, typing a space inside the card's
        // own textarea bubbles up and re-triggers this handler, closing the card mid-edit and
        // swallowing the keystroke — caught by an e2e test typing through a real space character.
        if ((event.target as HTMLElement).closest('.dc-edge-attachment-card')) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        togglePin();
      }}
    >
      <span className="dc-edge-attachment-chip-icon" aria-hidden="true">
        {kind === 'code' ? '{ }' : ''}
      </span>
      <span className="dc-edge-attachment-chip-label">{look.label}</span>

      {cardMounted && (
        <div
          className="dc-edge-attachment-card"
          data-pinned={pinned ? 'true' : undefined}
          data-closing={cardClosing ? 'true' : undefined}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {/* The reveal animation lives on this inner wrapper, not the positioned outer div —
              a CSS animation replaces the whole `transform` property for its duration, so
              animating scale here would otherwise clobber the outer div's own translate. */}
          <div className="dc-edge-attachment-card-inner" data-kind={kind} style={chipVars}>
            <header
              className="dc-edge-attachment-card-header"
              style={look.headerBg ? { background: look.headerBg } : undefined}
            >
              <span>{look.label}</span>
              {pinned && (
                <span className="dc-edge-attachment-card-actions">
                  {!editing && editable && (
                    <button
                      type="button"
                      className="dc-edge-attachment-card-action"
                      aria-label="Edit attached detail"
                      title="Edit"
                      onClick={() => setEditing(true)}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="dc-edge-attachment-card-action"
                    aria-label="Delete attached detail"
                    title="Delete"
                    onClick={() => {
                      removeEdgeAttachment(edge.id, attachment.id);
                      setOpenEdgeDetail(null);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              )}
            </header>
            {pinned && editing ? (
              attachment.type === 'code' ? (
                <textarea
                  autoFocus
                  className="dc-attachment-editor dc-attachment-editor-code"
                  spellCheck={false}
                  defaultValue={attachment.code ?? ''}
                  onChange={(event) => {
                    pendingValueRef.current = event.currentTarget.value;
                  }}
                  // Without this, a keystroke here bubbles all the way up to React Flow's own
                  // per-edge keydown handler — reachable because `EdgeLabelRenderer` still portals
                  // through the *React* tree, even though the DOM node itself lives elsewhere — and
                  // Enter/Space there means "select this edge", popping `EdgeInspectorPopover` open
                  // behind the card the user is mid-edit on.
                  onKeyDown={(event) => event.stopPropagation()}
                />
              ) : (
                <textarea
                  autoFocus
                  className="dc-attachment-editor"
                  defaultValue={attachment.text ?? ''}
                  onChange={(event) => {
                    pendingValueRef.current = event.currentTarget.value;
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              )
            ) : attachment.type === 'code' ? (
              <ReadOnlyCode language={attachment.language ?? 'plaintext'} code={attachment.code ?? ''} />
            ) : (
              <div className="dc-edge-attachment-note">{attachment.text || 'Empty note'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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

  // `endDrag` already removes this on a normal pointer-up/Escape, but if the
  // component unmounts mid-drag (e.g. this edge is deleted while its
  // endpoint is being dragged), that path never runs — this is the backstop.
  useEffect(() => {
    return () => {
      if (onKeyDownRef.current) window.removeEventListener('keydown', onKeyDownRef.current);
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

  return (
    <div
      className="dc-edge-endpoint"
      style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

/** Mirrors `badgePoint` in `edges/describe.ts`, in screen coordinates. */
const BADGE_OFFSET = 22;

function badgeX(route: ReturnType<typeof routeBetween>): number {
  const side = route.source.side;
  if (side === 'left') return route.source.x - BADGE_OFFSET;
  if (side === 'right') return route.source.x + BADGE_OFFSET;
  return route.source.x;
}

function badgeY(route: ReturnType<typeof routeBetween>): number {
  const side = route.source.side;
  if (side === 'top') return route.source.y - BADGE_OFFSET;
  if (side === 'bottom') return route.source.y + BADGE_OFFSET;
  return route.source.y;
}

