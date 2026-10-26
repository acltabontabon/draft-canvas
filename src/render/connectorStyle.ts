import type { ConnectorAppearance, DraftEdge } from '../document/types';
import { roundedStepPath } from '../edges/routing';
import { stepPolyline } from '../edges/waypoints';
import { Lru } from '../lib/lru';
import { LIMITS } from '../document/limits';
import { PERSONALITY_PROFILES, type PersonalityProfile } from './roughness/presets';

/** Physical units, shared by canvas, export and the appearance picker. */
export const CONNECTOR_STYLE = {
  lineWidth: 2.1,
  arrowLength: 14,
  arrowWidth: 10,
  arrowNotch: 4,
  openArrowWidth: 1.5,
} as const;

export const CONNECTOR_TREATMENTS = {
  sculpted: { label: 'Sculpted Ink', description: 'Sweeping corners · carved nibs', lineWidth: 2.1, radius: 26 },
  ribbon: { label: 'Flowing Ribbon', description: 'Fluid bends · luminous ink', lineWidth: 3.6, radius: 40 },
  technical: { label: 'Technical Pen', description: 'Precise elbows · crisp direction', lineWidth: 1.8, radius: 3 },
  pencil: { label: 'Pencil Sketch', description: 'Hand-drawn lines · expressive heads', lineWidth: 1.6, radius: 14 },
} as const satisfies Record<ConnectorAppearance, { label: string; description: string; lineWidth: number; radius: number }>;

const PENCIL_PROFILE: PersonalityProfile = { ...PERSONALITY_PROFILES.sketch, outline: 1.25, bow: 1.6, arrowJitter: 0.75 };

/** Explicit treatments override page personality; untouched arrows still follow Draft/Sketch. */
export function connectorProfile(edge: Pick<DraftEdge, 'appearance'>, fallback: PersonalityProfile): PersonalityProfile {
  if (edge.appearance === 'pencil') return PENCIL_PROFILE;
  return edge.appearance ? PERSONALITY_PROFILES.clean : fallback;
}

const styled = new Lru<string, string>(LIMITS.maxEdges * 2);

/** Restyle existing orthogonal bends, never choose a new corridor, endpoint or waypoint.
 * A rounded corner cuts at most 12 units inside its elbow (40 × .293), within the router's
 * 16-unit obstacle margin. Explicit bends and Bézier routes keep their exact geometry. */
export function styledConnectorPath(d: string, edge: Pick<DraftEdge, 'appearance' | 'routing' | 'waypoints'>, cache = true): string {
  if (edge.routing !== 'smoothstep' || edge.waypoints?.length || /[CA]/.test(d) || !d.includes('Q')) return d;
  const radius = CONNECTOR_TREATMENTS[edge.appearance ?? 'sculpted'].radius;
  const key = `${radius}|${d}`;
  const build = () => {
    const points = stepPolyline(d);
    if (points.length < 3 || points.some((p, i) => i > 0 && p.x !== points[i - 1]!.x && p.y !== points[i - 1]!.y)) return d;
    return roundedStepPath(points, radius);
  };
  return cache ? styled.getOrCreate(key, build) : styled.get(key) ?? build();
}

/** A fourteen-unit nib, pointing right. Shared by markers, picker previews and pencil heads. */
export function connectorHead(appearance: ConnectorAppearance = 'sculpted', open = false): string {
  switch (appearance) {
    case 'sculpted': return open
      ? 'M0 0 C5 0 9 4.5 14 5 C9 5.5 5 10 0 10'
      : 'M14 5 C9 4.5 5 0 0 0 Q2 4 4 5 Q2 6 0 10 C5 10 9 5.5 14 5 Z';
    case 'ribbon': return open
      ? 'M2 0 Q7 5 14 5 Q7 5 2 10'
      : 'M14 5 Q8 3 0 0 Q3 5 0 10 Q8 7 14 5 Z';
    case 'technical': return open ? 'M4 1 L14 5 L4 9' : 'M4 1 L14 5 L4 9 L7 5 Z';
    case 'pencil': return open ? 'M1 0.8 L14 5 L0 9.2' : 'M14 5 L0 0.8 L3 5.6 L0.7 9.2 Z';
  }
}
