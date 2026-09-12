/**
 * Small geometry helpers shared between `DraftEdgeView` and
 * `EdgeInspectorPopover` — split out into their own module (rather than
 * exported from a component file) purely so both keep fast refresh working;
 * neither of these is itself a component.
 */
import type { useInternalNode } from '@xyflow/react';
import { anchorBandOf } from '../document/queueGeometry';
import type { DraftNode, DraftNodeType } from '../document/types';
import { rectOf, type Rect } from '../edges/routing';
import { nodeIndex } from '../store/selectors';

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
  const band = type ? anchorBandOf({ type, y: rect.y, height }) : undefined;
  return band ? { ...rect, anchorBand: band } : rect;
}

/**
 * Whether a UI element floating above `(x, y)` at roughly `ATTACHMENT_ROW_NOMINAL_REACH`
 * pixels tall would land inside the connector's own source or target node — the
 * short-connector failure mode both `EdgeAttachmentRow` and `EdgeInspectorPopover`
 * avoid by flipping to sit below the connector instead. See `EdgeAttachmentRow`'s
 * fuller comment in `DraftEdgeView.tsx` for why this is a single-point check, not a
 * real box-overlap test.
 */
const NOMINAL_REACH = 150;
const GAP = 12;

export function attachmentRowBelowsSourceOrTarget(x: number, y: number, sourceRect: Rect, targetRect: Rect): boolean {
  const bottom = y - GAP;
  const top = bottom - NOMINAL_REACH;
  const overlapsRect = (rect: Rect) =>
    x > rect.x && x < rect.x + rect.width && rect.y < bottom && rect.y + rect.height > top;
  return overlapsRect(sourceRect) || overlapsRect(targetRect);
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
  return Math.min(Math.max(desiredCenterX, left), right);
}

/* ------------------------------------------------------------ obstacles -- */

const OBSTACLE_CELL = 512;
/** Well past `detourAround`'s own 10px band: an obstacle can only bend a connector if it overlaps
 *  the box between its two endpoints, so anything further out can never change the route. */
const OBSTACLE_REACH = 32;
const NO_RECTS: readonly Rect[] = [];

interface ObstacleGrid {
  cells: Map<string, DraftNode[]>;
  order: Map<DraftNode, number>;
  results: Map<string, readonly Rect[]>;
}

const obstacleRects = new WeakMap<DraftNode, Rect>();
const obstacleGrids = new WeakMap<readonly DraftNode[], ObstacleGrid>();

function stableRectOf(node: DraftNode): Rect {
  let rect = obstacleRects.get(node);
  if (!rect) obstacleRects.set(node, (rect = rectOf(node)));
  return rect;
}

function gridFor(nodes: readonly DraftNode[]): ObstacleGrid {
  let grid = obstacleGrids.get(nodes);
  if (grid) return grid;
  grid = { cells: new Map(), order: new Map(), results: new Map() };
  nodes.forEach((node, index) => {
    if (node.type === 'group') return;
    grid!.order.set(node, index);
    for (let cx = Math.floor(node.x / OBSTACLE_CELL); cx <= Math.floor((node.x + node.width) / OBSTACLE_CELL); cx += 1) {
      for (let cy = Math.floor(node.y / OBSTACLE_CELL); cy <= Math.floor((node.y + node.height) / OBSTACLE_CELL); cy += 1) {
        const key = `${cx}:${cy}`;
        const cell = grid!.cells.get(key);
        if (cell) cell.push(node);
        else grid!.cells.set(key, [node]);
      }
    }
  });
  obstacleGrids.set(nodes, grid);
  return grid;
}

/**
 * The obstacles that could bend the connector between `sourceId` and `targetId` — every
 * non-boundary node other than its endpoints overlapping the box the two span. Routing with this
 * subset draws exactly what routing with every node draws (see `detourAround`), which is what keeps
 * the canvas and the exporter tracing the same path.
 *
 * Built for a per-connector store subscription: the grid and results are cached per `nodes` array
 * and each rect per node object, so under `useShallow` a connector re-renders only when a node
 * near it actually moves — not whenever any node anywhere commits.
 */
export function obstaclesForEdge(nodes: readonly DraftNode[], sourceId: string, targetId: string): readonly Rect[] {
  const grid = gridFor(nodes);
  const key = `${sourceId}|${targetId}`;
  const cached = grid.results.get(key);
  if (cached) return cached;

  const index = nodeIndex(nodes);
  const source = index.get(sourceId);
  const target = index.get(targetId);
  if (!source || !target) {
    grid.results.set(key, NO_RECTS);
    return NO_RECTS;
  }
  const minX = Math.min(source.x, target.x) - OBSTACLE_REACH;
  const minY = Math.min(source.y, target.y) - OBSTACLE_REACH;
  const maxX = Math.max(source.x + source.width, target.x + target.width) + OBSTACLE_REACH;
  const maxY = Math.max(source.y + source.height, target.y + target.height) + OBSTACLE_REACH;

  const found = new Set<DraftNode>();
  const consider = (node: DraftNode) => {
    if (node === source || node === target || node.type === 'group') return;
    if (node.x < maxX && node.x + node.width > minX && node.y < maxY && node.y + node.height > minY) found.add(node);
  };
  const cellsX = Math.floor(maxX / OBSTACLE_CELL) - Math.floor(minX / OBSTACLE_CELL) + 1;
  const cellsY = Math.floor(maxY / OBSTACLE_CELL) - Math.floor(minY / OBSTACLE_CELL) + 1;
  if (cellsX * cellsY > grid.order.size) {
    // A connector spanning most of a sparse canvas: visiting every cell would cost more than
    // simply checking every node.
    for (const node of grid.order.keys()) consider(node);
  } else {
    for (let cx = Math.floor(minX / OBSTACLE_CELL); cx <= Math.floor(maxX / OBSTACLE_CELL); cx += 1) {
      for (let cy = Math.floor(minY / OBSTACLE_CELL); cy <= Math.floor(maxY / OBSTACLE_CELL); cy += 1) {
        for (const node of grid.cells.get(`${cx}:${cy}`) ?? []) consider(node);
      }
    }
  }
  const result =
    found.size === 0
      ? NO_RECTS
      : [...found].sort((a, b) => grid.order.get(a)! - grid.order.get(b)!).map(stableRectOf);
  grid.results.set(key, result);
  return result;
}
