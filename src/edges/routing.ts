import { Position, getBezierPath, getSmoothStepPath, getStraightPath } from '@xyflow/react';
import type { DraftEdge, DraftNode, EdgeRouting } from '../document/types';

/**
 * Edge geometry.
 *
 * This is the only module that calls React Flow's path helpers, and both the
 * live edge component and the SVG exporter call it. Identical inputs therefore
 * produce a byte-identical `d` attribute on screen and in an exported file.
 *
 * Endpoints are computed from the document's node rectangles rather than from
 * React Flow's measured handles: `getEdgePosition` needs an internal node with
 * measured handle bounds, which the exporter cannot have. Deriving anchors
 * ourselves keeps one implementation for both.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';

const SIDE_TO_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchor {
  x: number;
  y: number;
  side: Side;
}

export function rectOf(node: DraftNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

export function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Where a handle sits on a node. Shared by the live handles and the exporter. */
export function anchorPoint(rect: Rect, side: Side): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  switch (side) {
    case 'top':
      return { x: cx, y: rect.y };
    case 'bottom':
      return { x: cx, y: rect.y + rect.height };
    case 'left':
      return { x: rect.x, y: cy };
    case 'right':
      return { x: rect.x + rect.width, y: cy };
  }
}

/**
 * Picks the pair of sides that gives the shortest, least-crossing connection.
 *
 * This is what removes the busywork of choosing connection points by hand, and
 * it re-runs whenever a node moves, so connections reroute themselves.
 */
export function chooseSides(source: Rect, target: Rect): { source: Side; target: Side } {
  const a = centerOf(source);
  const b = centerOf(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Compare the gaps rather than the raw deltas, so two nodes that are wide but
  // vertically stacked still connect top-to-bottom.
  const gapX = Math.abs(dx) - (source.width + target.width) / 2;
  const gapY = Math.abs(dy) - (source.height + target.height) / 2;

  if (gapX >= gapY) {
    return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
  }
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
}

export interface RoutedEdge {
  d: string;
  labelX: number;
  labelY: number;
  source: Anchor;
  target: Anchor;
}

export function routeBetween(
  sourceRect: Rect,
  targetRect: Rect,
  routing: EdgeRouting,
): RoutedEdge {
  const sides = chooseSides(sourceRect, targetRect);
  const from = anchorPoint(sourceRect, sides.source);
  const to = anchorPoint(targetRect, sides.target);

  const params = {
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: SIDE_TO_POSITION[sides.source],
    targetX: to.x,
    targetY: to.y,
    targetPosition: SIDE_TO_POSITION[sides.target],
  };

  let path: string;
  let labelX: number;
  let labelY: number;

  switch (routing) {
    case 'straight': {
      const [d, lx, ly] = getStraightPath({
        sourceX: params.sourceX,
        sourceY: params.sourceY,
        targetX: params.targetX,
        targetY: params.targetY,
      });
      path = d;
      labelX = lx;
      labelY = ly;
      break;
    }
    case 'bezier': {
      const [d, lx, ly] = getBezierPath(params);
      path = d;
      labelX = lx;
      labelY = ly;
      break;
    }
    case 'smoothstep':
    default: {
      const [d, lx, ly] = getSmoothStepPath({ ...params, borderRadius: 10 });
      path = d;
      labelX = lx;
      labelY = ly;
      break;
    }
  }

  return {
    d: path,
    labelX,
    labelY,
    source: { ...from, side: sides.source },
    target: { ...to, side: sides.target },
  };
}

export function routeEdge(
  edge: DraftEdge,
  nodes: Map<string, DraftNode>,
): RoutedEdge | null {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return null;
  return routeBetween(rectOf(source), rectOf(target), edge.routing);
}

export const HANDLE_SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

export function positionForSide(side: Side): Position {
  return SIDE_TO_POSITION[side];
}
