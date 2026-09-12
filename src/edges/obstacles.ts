/**
 * Obstacle lookup for routing — shared by the live canvas (`DraftEdgeView`, `EdgeInspectorPopover`)
 * and the exporter (`render/svg/document.ts`), so both route each connector against the same small
 * set of nearby nodes instead of every node on the canvas.
 */
import type { DraftNode } from '../document/types';
import { rectOf, type Rect } from './routing';

const OBSTACLE_CELL = 512;
/** Well past `detourAround`'s own 10px band: an obstacle can only bend a connector if it overlaps
 *  the box between its two endpoints, so anything further out can never change the route. */
const OBSTACLE_REACH = 32;
const NO_RECTS: readonly Rect[] = [];

interface ObstacleGrid {
  byId: Map<string, DraftNode>;
  cells: Map<string, DraftNode[]>;
  order: Map<DraftNode, number>;
  results: Map<string, readonly Rect[]>;
}

const obstacleRects = new WeakMap<DraftNode, Rect>();
/** Which node each cached obstacle rect stands for — see `withoutNodes`. */
const obstacleNodeIds = new WeakMap<Rect, string>();
const obstacleGrids = new WeakMap<readonly DraftNode[], ObstacleGrid>();

function stableRectOf(node: DraftNode): Rect {
  let rect = obstacleRects.get(node);
  if (!rect) {
    obstacleRects.set(node, (rect = rectOf(node)));
    obstacleNodeIds.set(rect, node.id);
  }
  return rect;
}

function gridFor(nodes: readonly DraftNode[]): ObstacleGrid {
  let grid = obstacleGrids.get(nodes);
  if (grid) return grid;
  grid = { byId: new Map(), cells: new Map(), order: new Map(), results: new Map() };
  nodes.forEach((node, index) => {
    grid!.byId.set(node.id, node);
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

  const source = grid.byId.get(sourceId);
  const target = grid.byId.get(targetId);
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

/**
 * `obstacles` (from `obstaclesForEdge`) minus the nodes in `excludedIds` — the nodes a gesture is
 * moving right now, whose committed rects are stale until it ends. Returns `obstacles` itself when
 * nothing is removed.
 */
export function withoutNodes(obstacles: readonly Rect[], excludedIds: ReadonlySet<string>): readonly Rect[] {
  if (excludedIds.size === 0 || obstacles.length === 0) return obstacles;
  const kept = obstacles.filter((rect) => !excludedIds.has(obstacleNodeIds.get(rect) ?? ''));
  return kept.length === obstacles.length ? obstacles : kept.length === 0 ? NO_RECTS : kept;
}
