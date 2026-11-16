/**
 * Small geometry helpers shared between `DraftEdgeView` and
 * `EdgeInspectorPopover` — split out into their own module (rather than
 * exported from a component file) purely so both keep fast refresh working;
 * neither of these is itself a component.
 */
import type { useInternalNode } from '@xyflow/react';
import { anchorBandOf } from '../document/queueGeometry';
import type { DraftEdge, DraftNode, DraftNodeType, Side } from '../document/types';
import { visibleEdges } from '../document/compensation';
import { connectorRouteInputs } from '../edges/connectorRoutes';
import { edgeRoutes } from '../edges/edgeRoutes';
import { labelGroupPlan } from '../edges/labelGroups';
import { obstaclesForEdge, withoutNodes } from '../edges/obstacles';
import { separationPlan } from '../edges/separation';
import { labelChipSide, labelLaneOffset, laneIndex, responseAwayAt, routeBetween, type Rect } from '../edges/routing';
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

// The chip row's placement moved beside the exporter's copy of the row (`edges/attachmentChips.ts`),
// so the canvas and the picture hang it off the same point by the same rule.
export { ATTACHMENT_ROW_GAP, attachmentRowBelowsSourceOrTarget } from '../edges/attachmentChips';

/**
 * A connector's label point, routed exactly as `DraftEdgeView` draws it — obstacles, lane, bundle
 * spine and the label's lane nudge included — for screen-space overlays that must point at where the
 * line really is (`EdgeInspectorPopover`, Presentation Mode's callout). A parallel or detoured
 * connector's label otherwise sits well away from where an overlay would point. `DraftEdgeView`
 * keeps its own cached call: it is the hot path and also routes the response half.
 *
 * `own` asks for this connector's own label point even when it shares a label with others: the
 * point its attachment chips and open-point marker hang from. `moving` (the shapes a gesture is
 * moving) lets a gesture leave a connector it doesn't touch drawn as at rest, as the canvas does.
 */
export function edgeLabelPoint(
  document: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  edge: DraftEdge,
  sourceRect: Rect,
  targetRect: Rect,
  { interactionActive = false, moving, own = false }: { interactionActive?: boolean; moving?: ReadonlySet<string>; own?: boolean } = {},
): { x: number; y: number; side: Side } {
  const edges = visibleEdges(document.edges);
  const lane = laneIndex(edges).get(edge.id)?.offset ?? 0;
  // As `DraftEdgeView` decides it: a gesture redraws a connector live, the quick way and around the
  // shapes still at rest, only while one of its ends or a shape it detours around is moving. Without
  // `moving`, every connector is taken to be moving.
  let live: readonly Rect[] | undefined;
  if (interactionActive) {
    const endMoving = !moving || moving.has(edge.source) || moving.has(edge.target);
    const nearby = endMoving ? [] : obstaclesForEdge(document.nodes, edge.source, edge.target);
    const still = endMoving ? nearby : withoutNodes(nearby, moving);
    if (endMoving || still !== nearby) live = still;
  }
  // The live rects the overlay measures against; the rest from the document, as every renderer reads it.
  const inputs = connectorRouteInputs(edge, { nodes: document.nodes, edges }, 'canvas', undefined, {
    source: sourceRect,
    target: targetRect,
    ...(live ? { obstacles: live } : {}),
  });
  if (inputs && live) inputs.mode = 'gesture';
  // The live rects make `connectorRouteInputs` leave out the separation tracks, which the canvas
  // draws at rest: without them an overlay points 10–20px off a connector moved onto a track.
  const tracks = inputs && !live ? separationPlan(document.nodes, edges).tracksFor(edge.id) : undefined;
  if (inputs && tracks) inputs.tracks = tracks;
  const routes = inputs ? edgeRoutes(inputs, 'transient') : null;
  const route = routes?.request ?? routeBetween(sourceRect, targetRect, edge.routing, { anchors: { source: edge.sourceAnchor, target: edge.targetAnchor }, waypoints: edge.waypoints, lane });
  // A connector sharing one label with others (`edges/labelGroups.ts`) is pointed at where that one
  // label is drawn, not at the spot its own would have taken.
  const shared = live || own ? undefined : labelGroupPlan(document.nodes, edges).groupFor(edge.id);
  if (shared) return { x: shared.x, y: shared.y, side: shared.side };
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, lane);
  const side = labelChipSide(route.labelSide, responseAwayAt(route, routes?.response, lane));
  return { x: route.labelX + labelNudge.x, y: route.labelY + labelNudge.y, side };
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

