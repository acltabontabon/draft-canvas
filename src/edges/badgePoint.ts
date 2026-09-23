import type { EdgeRouting } from '../document/types';
import type { RoutedEdge, Side } from './routing';

/** How far along the connector, from where it leaves the source, its step badge sits. */
const BADGE_OFFSET = 22;

/** Half the drawn badge: 18px across on screen (`.dc-edge-step`), the same in exported units. */
const BADGE_RADIUS = 9;

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

/**
 * Whether the step badge would sit on top of whatever the connector says at `captionAt` — its
 * relationship caption, or the small glyph an event/conditional connector draws at the same point.
 *
 * This exists because "is this connector a numbered step?" used to stand in for the question, and
 * that is far too coarse: the badge sits just clear of the *source* (`badgePoint` above) while a
 * caption sits along the line, so on most connectors the two never meet — yet the words came off
 * every one of them the moment it joined a flow. They genuinely do collide on a short stacked run,
 * where `badgePoint`'s fixed 22-unit walk lands on the caption's own point, so the question is
 * asked exactly, per connector, by both renderers.
 */
export function badgeCrowds(
  badgeAt: { x: number; y: number },
  captionAt: { x: number; y: number },
): boolean {
  // `captionAt` is the point *on the line*; `captionAnchor` then pushes the words a further
  // `LABEL_LINE_GAP` clear of it (more, on a horizontal run). So the honest test is barely wider
  // than the badge itself — measuring as though the caption sat on the line would take the words
  // off ordinary connectors like a Client one shape above its Gateway, which is the very thing
  // this was written to stop.
  const clearance = BADGE_RADIUS + 3;
  return Math.hypot(badgeAt.x - captionAt.x, badgeAt.y - captionAt.y) < clearance;
}
