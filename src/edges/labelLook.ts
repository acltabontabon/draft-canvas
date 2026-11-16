import type { DraftEdge } from '../document/types';

/** Everything that has to match for connectors leaving one shape to share one label — `labelGroups.ts`'s rule. */
export function labelLook(edge: DraftEdge): string | null {
  if (!edge.label?.trim() || edge.condition || edge.cadence || edge.hasResponse || edge.response || edge.attachments?.length) return null;
  return JSON.stringify([edge.label.trim(), edge.kind ?? null, Boolean(edge.async), edge.semantic ?? null, edge.directed, edge.routing, edge.accent ?? null]);
}
