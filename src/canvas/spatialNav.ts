import type { DraftDocument, DraftNode } from '../document/types';

/** The four arrow-key directions, spelled out rather than reusing `'ArrowRight'` etc. — this
 *  module has no notion of keyboard events, only geometry and graph edges. */
export type Direction = 'up' | 'down' | 'left' | 'right';

interface Point {
  x: number;
  y: number;
}

function centerOf(node: DraftNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * Picks the most reasonable node in `direction` from `origin` among `nodes` — direction, distance
 * and alignment, not a line-of-sight/occlusion model. A candidate behind `origin` on the requested
 * axis is never eligible; among the rest, perpendicular offset is weighted more heavily than raw
 * distance, so a somewhat-further but well-aligned neighbor beats a closer one sitting off to the
 * side — reads as "the node in that direction", not "the nearest point in that half-plane". Not
 * academically perfect by design (the brief only asks that it feel intuitive on a typical,
 * roughly-grid-like architecture diagram, not that it be provably optimal).
 */
export function nearestInDirection(
  nodes: readonly DraftNode[],
  origin: Point,
  direction: Direction,
  excludeId?: string,
): string | null {
  let best: { id: string; score: number } | null = null;
  for (const node of nodes) {
    if (node.id === excludeId) continue;
    const center = centerOf(node);
    const dx = center.x - origin.x;
    const dy = center.y - origin.y;
    let primary: number;
    let perpendicular: number;
    switch (direction) {
      case 'right':
        primary = dx;
        perpendicular = dy;
        break;
      case 'left':
        primary = -dx;
        perpendicular = dy;
        break;
      case 'down':
        primary = dy;
        perpendicular = dx;
        break;
      case 'up':
        primary = -dy;
        perpendicular = dx;
        break;
    }
    if (primary <= 0) continue;
    const score = primary + Math.abs(perpendicular) * 2;
    if (!best || score < best.score) best = { id: node.id, score };
  }
  return best?.id ?? null;
}

/** Which end of an edge counts as the "neighbor" when cycling in `direction`. */
export type RelationshipDirection = 'outgoing' | 'incoming';

/**
 * Cycles through `nodeId`'s connected neighbors in `direction` (outgoing: edges where it's the
 * source; incoming: where it's the target) — deterministic document order, wrapping around. Pass
 * the currently-highlighted neighbor as `afterId` to advance to the next one on repeated presses;
 * omit it to start from the first. Returns `null` when there's nothing to cycle to.
 */
export function nextRelationshipNeighbor(
  document: Pick<DraftDocument, 'edges'>,
  nodeId: string,
  direction: RelationshipDirection,
  afterId?: string | null,
): string | null {
  const neighbors = document.edges
    .filter((edge) => (direction === 'outgoing' ? edge.source === nodeId : edge.target === nodeId))
    .map((edge) => (direction === 'outgoing' ? edge.target : edge.source));
  if (neighbors.length === 0) return null;
  if (!afterId) return neighbors[0]!;
  const index = neighbors.indexOf(afterId);
  if (index === -1) return neighbors[0]!;
  return neighbors[(index + 1) % neighbors.length]!;
}
