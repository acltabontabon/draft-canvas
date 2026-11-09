import { visibleEdges } from '../document/compensation';
import { moveNodes } from '../document/operations';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { rectOf } from './routing';
import { straightOffset } from './straight';

/**
 * Straighten: the light alternative to Arrange. Every connector that misses running straight by a
 * few pixels — a kink a caption hangs off, or a jog right before the arrowhead — has one of its
 * shapes nudged onto the line (`straightOffset`: each shape's anchor axis, the middle of a tube or
 * a Data Store's glyph), and nothing else moves. A layout stays the layout it was.
 *
 * Shapes joined by a line that is already straight move together, so straightening one connector
 * never kinks another; a move that would push a shape onto another, or out of its boundary, is
 * tried the other way round and otherwise left alone. Pure: the store commits the result as one
 * undo step (`editorStore.straighten`).
 */

/** The largest kink Straighten removes. Past this a misalignment is a layout choice, not a slip. */
export const STRAIGHTEN_LIMIT = 16;

/** Below this two ends are level already: what a drag snap or a past straighten leaves. */
const LEVEL = 0.5;

interface Graph {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function inside(inner: Box, outer: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * The new positions that straighten `graph`'s near-straight connectors, by shape id; only shapes
 * that move are listed. `movable` limits which shapes may move (a selection); absent, any may.
 */
export function straightenPositions(
  graph: Graph,
  options: { movable?: ReadonlySet<string>; limit?: number } = {},
): Map<string, { x: number; y: number }> {
  const limit = options.limit ?? STRAIGHTEN_LIMIT;
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const at = new Map(graph.nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const));
  const live = (id: string): DraftNode => ({ ...byId.get(id)!, ...at.get(id)! });
  // Boundaries are frames, not ends worth straightening onto; the connectors that count join two
  // ordinary shapes, and are drawn (a folded compensation has no line to straighten).
  const edges = visibleEdges(graph.edges).filter((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return source && target && edge.source !== edge.target && source.type !== 'group' && target.type !== 'group' && !edge.waypoints?.length;
  });
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const offsetOf = (edge: DraftEdge) => straightOffset(edge, rectOf(live(edge.source)), rectOf(live(edge.target)));

  for (const axis of ['y', 'x'] as const) {
    // Rigid groups: shapes a straight line on this axis already joins.
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      let root = id;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(id, root);
      return root;
    };
    const members = (root: string) => graph.nodes.filter((node) => find(node.id) === root).map((node) => node.id);
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    const joinLevel = () => {
      for (const edge of edges) {
        const offset = offsetOf(edge);
        if (offset?.axis === axis && Math.abs(offset.delta) < LEVEL) union(edge.source, edge.target);
      }
    };
    joinLevel();

    const kinks = edges
      .map((edge) => ({ edge, offset: offsetOf(edge) }))
      .filter(({ offset }) => offset?.axis === axis && Math.abs(offset.delta) >= LEVEL && Math.abs(offset.delta) <= limit)
      .sort((a, b) => Math.abs(a.offset!.delta) - Math.abs(b.offset!.delta));

    const tryMove = (ids: string[], by: number): boolean => {
      if (options.movable && ids.some((id) => !options.movable!.has(id))) return false;
      const group = new Set(ids);
      for (const id of ids) {
        const node = live(id);
        const moved = axis === 'x' ? { ...node, x: node.x + by } : { ...node, y: node.y + by };
        const parentNode = node.parentId ? byId.get(node.parentId) : undefined;
        if (parentNode && !group.has(parentNode.id) && inside(node, live(parentNode.id)) && !inside(moved, live(parentNode.id))) return false;
        for (const other of graph.nodes) {
          if (group.has(other.id)) continue;
          const box = live(other.id);
          // A boundary the shape sits in is its frame, not something it bumps into.
          if (other.type === 'group' && inside(node, box)) continue;
          if (overlapArea(moved, box) > overlapArea(node, box) + 0.01) return false;
        }
      }
      for (const id of ids) {
        const position = at.get(id)!;
        at.set(id, axis === 'x' ? { x: position.x + by, y: position.y } : { x: position.x, y: position.y + by });
      }
      return true;
    };

    for (const { edge } of kinks) {
      const offset = offsetOf(edge);
      if (!offset || offset.axis !== axis || Math.abs(offset.delta) < LEVEL || Math.abs(offset.delta) > limit) continue;
      const sourceRoot = find(edge.source);
      const targetRoot = find(edge.target);
      if (sourceRoot === targetRoot) continue;
      const sourceGroup = members(sourceRoot);
      const targetGroup = members(targetRoot);
      const weight = (ids: string[]) => ids.reduce((sum, id) => sum + (degree.get(id) ?? 0), 0);
      // The lighter side moves: fewer shapes, then fewer connectors; on a tie, the target, as a
      // connector is drawn towards it.
      const targetFirst = targetGroup.length < sourceGroup.length
        || (targetGroup.length === sourceGroup.length && weight(targetGroup) <= weight(sourceGroup));
      const attempts: [string[], number][] = targetFirst
        ? [[targetGroup, offset.delta], [sourceGroup, -offset.delta]]
        : [[sourceGroup, -offset.delta], [targetGroup, offset.delta]];
      if (attempts.some(([ids, by]) => tryMove(ids, by))) {
        union(edge.source, edge.target);
        // A move can level other lines too: they hold together from here on.
        joinLevel();
      }
    }
  }

  const moved = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const position = at.get(node.id)!;
    if (position.x !== node.x || position.y !== node.y) moved.set(node.id, position);
  }
  return moved;
}

/**
 * The document operation: `doc` with its near-straight connectors straightened (see
 * `straightenPositions`), or `doc` itself when there is nothing to do.
 */
export function straightenConnectors(doc: DraftDocument, movable?: ReadonlySet<string>): DraftDocument {
  const positions = straightenPositions(doc, movable ? { movable } : {});
  return positions.size === 0 ? doc : moveNodes(doc, positions);
}
