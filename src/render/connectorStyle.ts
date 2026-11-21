import type { DraftEdge } from '../document/types';
import { roundedStepPath } from '../edges/routing';
import { stepPolyline } from '../edges/waypoints';
import { Lru } from '../lib/lru';
import { LIMITS } from '../document/limits';
import type { PersonalityProfile } from './roughness/presets';
import { pencilPath } from './roughness/pencilPath';
import { roughenPath } from './roughness/roughPath';

/**
 * Sculpted Ink proportions, shared by canvas and export at every drawing style.
 *
 * The line is a hair finer than a shape's own outline is bold (1.5), so connectors read as drawn
 * between shapes and never compete with them; the head is long and narrow, a nib and not a wedge;
 * and a directed line begins at a small dot just clear of its shape, so where it leaves is as
 * legible as where it lands.
 */
export const CONNECTOR_STYLE = {
  lineWidth: 1.8,
  arrowLength: 14,
  arrowWidth: 8,
  openArrowWidth: 1.4,
  cornerRadius: 26,
  originRadius: 2.1,
  /** How far along the line from its shape the origin dot's centre sits. */
  originGap: 3.4,
} as const;

/** Drawing style is a device preference shared by shapes and connectors, never an edge field. */
export function connectorStrokePath(d: string, seedId: string, profile: PersonalityProfile, cache = true, continuous = false): string {
  // Crossing humps need an uninterrupted curve across their span; tiny pencil segments would
  // make an otherwise clear crossing unbridgeable. Keep the established Sketch bow there.
  return !continuous && profile.arrowStyle === 'per-edge-hand'
    ? pencilPath(d, seedId, cache)
    : roughenPath(d, seedId, profile.outline, profile.bow, cache);
}

const styled = new Lru<string, string>(LIMITS.maxEdges * 2);

/** Round existing orthogonal bends without choosing a new corridor, endpoint or waypoint.
 * The 26-unit corners stay inside the router's 16-unit obstacle margin. Explicit bends and
 * Bézier routes keep their exact geometry. */
export function styledConnectorPath(d: string, edge: Pick<DraftEdge, 'routing' | 'waypoints'>, cache = true): string {
  if (edge.routing !== 'smoothstep' || edge.waypoints?.length || /[CA]/.test(d) || !d.includes('Q')) return d;
  const build = () => {
    const points = stepPolyline(d);
    if (points.length < 3 || points.some((p, i) => i > 0 && p.x !== points[i - 1]!.x && p.y !== points[i - 1]!.y)) return d;
    return roundedStepPath(points, CONNECTOR_STYLE.cornerRadius);
  };
  return cache ? styled.getOrCreate(d, build) : styled.get(d) ?? build();
}

/** A curved, carved nib pointing right. Sketch jitters this same geometry per edge. */
export function connectorHead(open = false): string {
  // Drawn in the `arrowLength` × `arrowWidth` box, tip at its right middle: (14, 4).
  return open
    ? 'M0 0 C5 0 9 3.6 14 4 C9 4.4 5 8 0 8'
    : 'M14 4 C9 3.6 5 0 0 0 Q2 3.2 3.6 4 Q2 4.8 0 8 C5 8 9 4.4 14 4 Z';
}
