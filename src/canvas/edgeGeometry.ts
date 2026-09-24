/**
 * Small geometry helpers shared between `DraftEdgeView` and
 * `EdgeInspectorPopover` — split out into their own module (rather than
 * exported from a component file) purely so both keep fast refresh working;
 * neither of these is itself a component.
 */
import type { useInternalNode } from '@xyflow/react';
import { anchorBandOf } from '../document/queueGeometry';
import type { DraftEdge, DraftNode, DraftNodeType, Side } from '../document/types';
import { routingPlan } from '../edges/bundles';
import { labelGroupPlan } from '../edges/labelGroups';
import { obstaclesForEdge } from '../edges/obstacles';
import { labelLaneOffset, laneIndex, routeBetween, type Rect } from '../edges/routing';
import { clamp } from '../lib/math';

export type InternalNode = NonNullable<ReturnType<typeof useInternalNode>>;

/**
 * `type` opts the rect into its node kind's anchor band (a queue-family node's tube) — routing
 * callers pass it; popover-placement callers, which only want the box, leave it out.
 */
export function rectOfInternal(node: InternalNode, type?: DraftNodeType): Rect | null {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  if (width == null || height == null) return null;
  const rect: Rect = {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
  const band = type ? anchorBandOf({ type, x: rect.x, y: rect.y, width, height }) : undefined;
  return band ? { ...rect, anchorBand: band } : rect;
}

/** How far a connector's attachment chip row floats off its label point, in flow units. */
export const ATTACHMENT_ROW_GAP = 12;

/**
 * Whether a UI element floating above `(x, y)` at roughly `NOMINAL_REACH`
 * pixels tall would land inside the connector's own source or target node — the
 * short-connector failure mode both a connector's attachment chip row and `EdgeInspectorPopover`
 * avoid by flipping to sit below the connector instead. A single-point check, not a real
 * box-overlap test: the row's own width is unknown until rendered, and its anchor point is what
 * decides which side reads as belonging to the connector.
 */
const NOMINAL_REACH = 150;

export function attachmentRowBelowsSourceOrTarget(x: number, y: number, sourceRect: Rect, targetRect: Rect, captionSide?: Side): boolean {
  // Words already above the line own that side: the row hangs below the line instead of on top of
  // them (a caption placed above a horizontal line was covered by its own connector's chip row).
  if (captionSide === 'top') return true;
  const bottom = y - ATTACHMENT_ROW_GAP;
  const top = bottom - NOMINAL_REACH;
  const overlapsRect = (rect: Rect) =>
    x > rect.x && x < rect.x + rect.width && rect.y < bottom && rect.y + rect.height > top;
  return overlapsRect(sourceRect) || overlapsRect(targetRect);
}

/**
 * A connector's label point, routed exactly as `DraftEdgeView` draws it — obstacles, lane, bundle
 * spine and the label's lane nudge included — for screen-space overlays that must point at where the
 * line really is (`EdgeInspectorPopover`, Presentation Mode's callout). A parallel or detoured
 * connector's label otherwise sits well away from where an overlay would point. `DraftEdgeView`
 * keeps its own cached call: it is the hot path and also routes the response half.
 */
export function edgeLabelPoint(
  document: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  edge: DraftEdge,
  sourceRect: Rect,
  targetRect: Rect,
  { interactionActive = false }: { interactionActive?: boolean } = {},
): { x: number; y: number; side: Side } {
  const lane = laneIndex(document.edges).get(edge.id)?.offset ?? 0;
  const route = routeBetween(sourceRect, targetRect, edge.routing, {
    anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
    lane,
    obstacles: interactionActive ? undefined : obstaclesForEdge(document.nodes, edge.source, edge.target),
    spine: routingPlan(document.nodes, document.edges).spineFor(edge.id),
  });
  // A connector sharing one label with others (`edges/labelGroups.ts`) is pointed at where that one
  // label is drawn, not at the spot its own would have taken.
  const shared = interactionActive ? undefined : labelGroupPlan(document.nodes, document.edges).groupFor(edge.id);
  if (shared) return { x: shared.x, y: shared.y, side: shared.side };
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, lane);
  return { x: route.labelX + labelNudge.x, y: route.labelY + labelNudge.y, side: route.labelSide };
}

/** Which side of its line a connector's label chip sits on, when it has one. A relationship caption
 *  is not counted: `captionAnchor` draws it below a horizontal line whatever `labelSide` says, so
 *  sending the chip row below for it would land the row on the caption instead. */
export function captionSideOf(edge: DraftEdge, labelSide: Side): Side | undefined {
  return edge.label ? labelSide : undefined;
}

export interface ScreenRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Shifts a popover's desired horizontal center just far enough to clear any obstacle it would
 * otherwise overlap — `EdgeInspectorPopover`'s guard for a short connector whose label point sits
 * in open canvas (so `attachmentRowBelowsSourceOrTarget`'s single-point check passes) while the
 * popover itself, several times wider than the gap between two nearby nodes, still reaches into
 * one of them. All rects are screen space. An obstacle only constrains the result if it vertically
 * overlaps the popover's own span; whichever side of `desiredCenterX` it falls on becomes a
 * one-sided bound. If both sides end up constrained past each other (nodes too close together for
 * the popover to ever fit between them, or a diagonal connector whose obstacle straddles the
 * center), the desired center is returned unclamped rather than fighting for a position that
 * doesn't exist.
 */
export function clampPopoverCenterX(
  desiredCenterX: number,
  halfWidth: number,
  gap: number,
  popoverTop: number,
  popoverBottom: number,
  obstacles: ScreenRect[],
): number {
  let left = -Infinity;
  let right = Infinity;
  for (const o of obstacles) {
    if (o.top >= popoverBottom || o.bottom <= popoverTop) continue;
    if (o.right <= desiredCenterX) left = Math.max(left, o.right + gap + halfWidth);
    else if (o.left >= desiredCenterX) right = Math.min(right, o.left - gap - halfWidth);
  }
  if (left > right) return desiredCenterX;
  return clamp(desiredCenterX, left, right);
}

