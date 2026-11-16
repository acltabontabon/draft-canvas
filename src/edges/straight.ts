import type { DraftEdge } from '../document/types';
import { anchorPoint, resolveSides, type Rect } from './routing';

/**
 * How far a connector's target would have to move, across the line, for the connector to run
 * perfectly straight — the two ends level on the line through each shape's anchor axis (the middle
 * of a queue's tube or a Data Store's glyph, not of the box around it).
 *
 * Only a connector whose ends face each other has one: right into left (or the reverse) is
 * straightened on `y`, bottom into top on `x`. A hand-bent connector keeps its bends and has none.
 * Shared by drag snapping (`canvas/snapping.ts`) and Straighten (`straightenConnectors`), so the
 * line a drag snaps to is the line Straighten makes.
 */
export interface StraightOffset {
  /** The axis the ends must share: `y` for a level connector, `x` for an upright one. */
  axis: 'x' | 'y';
  /** How far the target end must move along `axis`; the source would move by the opposite. */
  delta: number;
  /** The two ends as they stand. */
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export function straightOffset(
  edge: Pick<DraftEdge, 'sourceAnchor' | 'targetAnchor' | 'waypoints'>,
  source: Rect,
  target: Rect,
): StraightOffset | null {
  if (edge.waypoints?.length) return null;
  const sides = resolveSides(source, target, { source: edge.sourceAnchor, target: edge.targetAnchor });
  const from = anchorPoint(source, sides.source, edge.sourceAnchor?.offset ?? 0.5);
  const to = anchorPoint(target, sides.target, edge.targetAnchor?.offset ?? 0.5);
  if (sides.source === 'right' && sides.target === 'left' && to.x > from.x) return { axis: 'y', delta: from.y - to.y, from, to };
  if (sides.source === 'left' && sides.target === 'right' && to.x < from.x) return { axis: 'y', delta: from.y - to.y, from, to };
  if (sides.source === 'bottom' && sides.target === 'top' && to.y > from.y) return { axis: 'x', delta: from.x - to.x, from, to };
  if (sides.source === 'top' && sides.target === 'bottom' && to.y < from.y) return { axis: 'x', delta: from.x - to.x, from, to };
  return null;
}
