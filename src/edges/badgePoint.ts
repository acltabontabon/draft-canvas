import type { EdgeRouting } from '../document/types';
import type { RoutedEdge, Side } from './routing';

/** How far along the connector, from where it leaves the source, its step badge sits. */
const BADGE_OFFSET = 22;

const OUTWARD: Record<Side, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * Where the step number sits: just clear of the source node, on the line.
 *
 * Smooth-step and bezier paths both leave their anchor perpendicular to the
 * node edge, so walking out along that normal lands exactly on the drawn path.
 * A straight connector has no such segment, so it is interpolated instead.
 * Sampling the real geometry would need a live SVG element and would make this
 * unusable from the exporter.
 */
export function badgePoint(route: RoutedEdge, routing: EdgeRouting): { x: number; y: number } {
  // Every member of a fan-out leaves its hub from the *same* anchor, so
  // walking outward from `source` would stack all N step badges on one point.
  // `branchStart` is where this connector stops sharing and becomes its own
  // line, which is the first place a badge can identify which one it is.
  if (route.branchStart) {
    const dx = route.target.x - route.branchStart.x;
    const dy = route.target.y - route.branchStart.y;
    const length = Math.hypot(dx, dy) || 1;
    const t = Math.min(0.4, BADGE_OFFSET / length);
    return { x: route.branchStart.x + dx * t, y: route.branchStart.y + dy * t };
  }
  if (routing === 'straight') {
    const dx = route.target.x - route.source.x;
    const dy = route.target.y - route.source.y;
    const length = Math.hypot(dx, dy) || 1;
    const t = Math.min(0.4, BADGE_OFFSET / length);
    return { x: route.source.x + dx * t, y: route.source.y + dy * t };
  }
  const normal = OUTWARD[route.source.side];
  return {
    x: route.source.x + normal.x * BADGE_OFFSET,
    y: route.source.y + normal.y * BADGE_OFFSET,
  };
}
