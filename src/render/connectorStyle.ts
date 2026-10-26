import type { DraftEdge } from '../document/types';
import { roundedStepPath } from '../edges/routing';
import { stepPolyline } from '../edges/waypoints';
import { Lru } from '../lib/lru';
import { LIMITS } from '../document/limits';
import type { PersonalityProfile } from './roughness/presets';
import { pencilPath } from './roughness/pencilPath';
import { roughenPath } from './roughness/roughPath';

/** Sculpted Ink proportions, shared by canvas and export at every drawing style. */
export const CONNECTOR_STYLE = {
  lineWidth: 2.1,
  arrowLength: 14,
  arrowWidth: 10,
  openArrowWidth: 1.5,
  cornerRadius: 26,
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
  return open
    ? 'M0 0 C5 0 9 4.5 14 5 C9 5.5 5 10 0 10'
    : 'M14 5 C9 4.5 5 0 0 0 Q2 4 4 5 Q2 6 0 10 C5 10 9 5.5 14 5 Z';
}
