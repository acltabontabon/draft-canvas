import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps } from '@xyflow/react';
import type { Attachment, DraftEdge, DraftNode } from '../document/types';
import { explainEdgeTier, stepIndexOf } from '../document/flow';
import { markerRef } from '../render/svg/markers';
import {
  LABEL_LINE_GAP,
  anchorForDrop,
  labelLaneOffset,
  laneIndex,
  rectOf,
  routeBetween,
  type Rect,
  type Side,
} from '../edges/routing';
import { dashForEdge, markerVariantForEdge, resolveEdgeColor } from '../edges/kindStyle';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import { NOTE_ACCENTS, NOTE_LABELS } from '../nodes/describe';
import { LANGUAGE_LABELS, tokenizeCode } from '../render/code/highlight';
import { CODE_THEMES, colorForScope } from '../render/code/theme';
import { accentOf, type Theme } from '../render/theme/tokens';
import { isEdgeFocused, useEditorStore } from '../store/editorStore';
import { selectEdge, selectNode } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { useTheme, useThemeValue } from '../ui/theme/useTheme';
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
 *  row is compact and doesn't need the same clearance a full label chip does. */
const ATTACHMENT_ROW_GAP = 12;

/** The row sits above the connector by default — the natural, expected spot per a connection's
 *  own reading direction — and only flips below when "above" would land inside the very node the
 *  connector is attached to (a short connector's most common failure mode). The probe distance
 *  covers a typical *open card*, not just the chip: a card opens further in the same direction the
 *  row already chose, so checking only the chip's own small height let a card on a short connector
 *  reach back into the node even when the chip itself had cleared it — caught by testing an actual
 *  short vertical connector in the browser, not by reasoning about it. A single point check against
 *  this nominal reach is deliberately approximate, not a real box-overlap test: a full collision
 *  solver is exactly what this project's connector work has consistently avoided. */
const ATTACHMENT_ROW_NOMINAL_REACH = 150;

function attachmentRowBelowsSourceOrTarget(x: number, y: number, sourceRect: Rect, targetRect: Rect): boolean {
  // The full span a card might occupy, not just its far edge — a node overlapping any part of
  // this vertical range (not only sitting exactly at its top) is what actually causes the
  // overlap this function exists to avoid.
  const bottom = y - ATTACHMENT_ROW_GAP;
  const top = bottom - ATTACHMENT_ROW_NOMINAL_REACH;
  const overlapsRect = (rect: Rect) =>
    x > rect.x && x < rect.x + rect.width && rect.y < bottom && rect.y + rect.height > top;
  return overlapsRect(sourceRect) || overlapsRect(targetRect);
}

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
  const color = resolveEdgeColor(edge, { accent: sourceAccent }, theme);

  const playingFlow = flowPlayback.active && flowPlayback.flowId
    ? flows.find((f) => f.id === flowPlayback.flowId)
    : undefined;
  const overlayFlow = selectedFlowId ? flows.find((f) => f.id === selectedFlowId) : undefined;
  const stepNumber = overlayFlow ? stepIndexOf(overlayFlow, edge.id) : undefined;

  const tier = playingFlow ? explainEdgeTier(stepIndexOf(playingFlow, edge.id), flowPlayback.step) : 'hidden';
  const isActiveStep = flowPlayback.active && tier === 'active';
  const isShownStep = flowPlayback.active && tier === 'shown';
  const dimmed = flowPlayback.active && tier === 'hidden';
  const focusDimmed = focus.active && !isEdgeFocused(focus, edge);

  const hasLabel = Boolean(edge.label);
  const hasStep = showSequence && typeof stepNumber === 'number';
  // The step being explained is the one thing that should stand out.
  // `style` renders as an inline attribute, which always wins over an
  // external stylesheet rule — so a selected connector's stroke and width
  // must be decided here, not in CSS (only the halo in `canvas.css` — a
  // `filter`, never set inline — can safely live there).
  const strokeColor = isActiveStep || selected || attachTarget ? theme.selection : color;
  const conditionText = edge.condition ? `[${edge.condition}]` : null;

  return (
    <g
      className="dc-edge"
      data-selected={selected ? 'true' : undefined}
      data-active={isActiveStep ? 'true' : undefined}
      data-shown={isShownStep ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      data-focus-dimmed={focusDimmed ? 'true' : undefined}
      data-flow-active={isActiveStep ? 'true' : undefined}
      data-attach-target={attachTarget ? 'true' : undefined}
    >
{/*
        `BaseEdge` draws the path and, through `interactionWidth`, a second
        invisible one wide enough to click. Hand-rolling that stroke is not
        enough: React Flow keys selection off its own interaction path.
      */}
      <BaseEdge
        className="dc-edge-line"
        path={route.d}
        markerEnd={edge.directed ? markerRef(strokeColor, markerVariantForEdge(edge)) : undefined}
        interactionWidth={18}
        style={{
          stroke: strokeColor,
          strokeWidth: isActiveStep ? 2.6 : selected || attachTarget ? 2.4 : 1.6,
          strokeLinecap: 'round',
          strokeDasharray: dashForEdge(edge)?.join(' '),
        }}
      />

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
      {/* A subtle caption of the relationship — independent of `kind`'s glyph
          above, so a plain call/read/write connector reads just as clearly as
          an event one. Yields entirely to a real label the moment there is one. */}
      {!hasLabel && !hasStep && edge.semantic && (() => {
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
            style={{
              transform: conditionTransform(route.labelSide, labelX, labelY),
            }}
          >
            <span className="dc-edge-condition" style={{ color }}>
              {conditionText}
            </span>
          </div>
        )}

        {/* Mounted only when there is something to reveal — no cost, no listeners, when an
            edge has no attachment. Stays mounted in presentation mode (hover still works
            there); only pinning into edit mode is gated to edit mode, below. */}
        {edge.attachments?.length ? (
          <EdgeAttachmentRow
            edge={edge}
            x={labelX}
            y={labelY}
            flipBelow={attachmentRowBelowsSourceOrTarget(labelX, labelY, sourceRect, targetRect)}
            selected={Boolean(selected)}
            editable={mode !== 'present'}
          />
        ) : null}
      </EdgeLabelRenderer>
    </g>
  );
});

/** How long after the pointer leaves both the marker and the card before it closes — long
 *  enough that moving from one to the other never flickers shut, short enough that it doesn't
 *  linger once the user has clearly moved on. */
const ATTACHMENT_CLOSE_DELAY_MS = 250;

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
 * target node, below) its label point — one chip per attachment, each independently
 * hoverable/pinnable, so several attachments sit side by side rather than competing for one card.
 */
function EdgeAttachmentRow({
  edge,
  x,
  y,
  flipBelow,
  selected,
  editable,
}: {
  edge: DraftEdge;
  x: number;
  y: number;
  flipBelow: boolean;
  selected: boolean;
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
        <EdgeAttachmentChip key={attachment.id} edge={edge} attachment={attachment} selected={selected} editable={editable} />
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
 * Visible when `hovering || selected || pinned`. Hover uses a close-delay timer (not React state
 * per tick) so moving from the chip into its card never flickers shut — `pointerenter`/`leave`
 * don't fire on crossing into a DOM descendant, so this only bridges the small CSS gap between
 * chip and card, not the whole hand-off. Selection makes the read-only preview reachable by
 * keyboard for free (selecting an edge already is) with no new key bindings; pinning (`uiStore`'s
 * `openEdgeDetail`, naming both the edge and this specific attachment) is the only state that
 * enables editing, and only when `editable` (i.e. not presenting).
 */
function EdgeAttachmentChip({
  edge,
  attachment,
  selected,
  editable,
}: {
  edge: DraftEdge;
  attachment: Attachment;
  selected: boolean;
  editable: boolean;
}) {
  const theme = useThemeValue();
  const look = attachmentLookFor(theme, attachment);
  const pinned = useUiStore(
    (state) => state.openEdgeDetail?.edgeId === edge.id && state.openEdgeDetail?.attachmentId === attachment.id,
  );
  const setOpenEdgeDetail = useUiStore((state) => state.setOpenEdgeDetail);
  const updateEdgeAttachment = useEditorStore((state) => state.updateEdgeAttachment);
  const removeEdgeAttachment = useEditorStore((state) => state.removeEdgeAttachment);

  const [hovering, setHovering] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setHovering(false), ATTACHMENT_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

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

  // Same precedent as `AttachmentPopover`: a capture-phase Escape (so it preempts
  // `EditorScreen`'s own bubble-phase chain), plus a click anywhere outside the card closes it —
  // registered a tick late so the very click that opened the card doesn't immediately close it.
  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpenEdgeDetail(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) setOpenEdgeDetail(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [pinned, setOpenEdgeDetail]);

  const visible = hovering || selected || pinned;
  const kind = attachment.type === 'code' ? 'code' : 'note';

  const togglePin = () => {
    if (!editable) return;
    setOpenEdgeDetail(pinned ? null : { edgeId: edge.id, attachmentId: attachment.id });
  };

  const chipVars = {
    ['--dc-chip-fill']: look.fill,
    ['--dc-chip-border']: look.border,
    ['--dc-chip-accent']: look.accent,
  } as CSSProperties;

  return (
    <div
      className="dc-edge-attachment-chip"
      data-kind={kind}
      role="button"
      tabIndex={0}
      title={pinned ? 'Close attached detail' : kind === 'code' ? 'View attached code' : 'View attached note'}
      // Set explicitly rather than left to default content-based computation: the card (with its
      // own, possibly lengthy, note/code content) is a DOM child of this chip for simple
      // CSS-relative positioning, and without this, that content would bleed into the chip's own
      // accessible name whenever it's open.
      aria-label={pinned ? 'Close attached detail' : kind === 'code' ? 'View attached code' : 'View attached note'}
      style={chipVars}
      onPointerEnter={() => {
        cancelClose();
        setHovering(true);
      }}
      onPointerLeave={scheduleClose}
      onClick={(event) => {
        // The card (delete button, textarea) is a DOM child of this chip, so a click anywhere
        // inside it bubbles up here too — only clicks that did *not* originate inside the card
        // should toggle pin. Checking the card specifically (not `target === currentTarget`)
        // matters: a real click on the chip's own icon/label spans also has to work, and those
        // are non-card descendants of this same div.
        if ((event.target as HTMLElement).closest('.dc-edge-attachment-card')) return;
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

      {visible && (
        <div
          ref={cardRef}
          className="dc-edge-attachment-card"
          data-pinned={pinned ? 'true' : undefined}
          onPointerEnter={() => {
            cancelClose();
            setHovering(true);
          }}
          onPointerLeave={scheduleClose}
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
                <button
                  type="button"
                  className="dc-edge-attachment-delete"
                  title="Delete attached detail"
                  onClick={() => {
                    removeEdgeAttachment(edge.id, attachment.id);
                    setOpenEdgeDetail(null);
                  }}
                >
                  Delete
                </button>
              )}
            </header>
            {pinned ? (
              attachment.type === 'code' ? (
                <textarea
                  autoFocus
                  className="dc-attachment-editor dc-attachment-editor-code"
                  spellCheck={false}
                  defaultValue={attachment.code ?? ''}
                  onChange={(event) => {
                    pendingValueRef.current = event.currentTarget.value;
                  }}
                />
              ) : (
                <textarea
                  autoFocus
                  className="dc-attachment-editor"
                  defaultValue={attachment.text ?? ''}
                  onChange={(event) => {
                    pendingValueRef.current = event.currentTarget.value;
                  }}
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

  const findDropNode = useCallback(
    (point: { x: number; y: number }) =>
      [...nodes]
        .filter((node) => node.type !== 'group')
        .sort((a, b) => b.z - a.z)
        .find(
          (node) =>
            point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height,
        ),
    [nodes],
  );

  const onKeyDownRef = useRef<(event: KeyboardEvent) => void>(undefined);

  const endDrag = useCallback(() => {
    if (onKeyDownRef.current) window.removeEventListener('keydown', onKeyDownRef.current);
    useUiStore.getState().setReconnectHoverTarget(null);
    useUiStore.getState().setInteractionActive(false);
    lastHover.current = null;
    dragStarted.current = false;
    startClient.current = null;
    onDrag(null);
  }, [onDrag]);

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
      }
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onDrag({ endpoint, point });
      const hoverId = findDropNode(point)?.id ?? null;
      if (hoverId !== lastHover.current) {
        lastHover.current = hoverId;
        useUiStore.getState().setReconnectHoverTarget(hoverId);
      }
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
      const anchor = anchorForDrop(rectOf(node), point);
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

type InternalNode = NonNullable<ReturnType<typeof useInternalNode>>;

function rectOfInternal(node: InternalNode): Rect | null {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  if (width == null || height == null) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}
