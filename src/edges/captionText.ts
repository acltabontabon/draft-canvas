import type { NodeCategory } from '../document/connectorSemantics';
import { capabilityFor } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { DraftEdge } from '../document/types';
import { compensationActionCaption } from './compensationMarker';

/**
 * The relationship caption a connector shows when it has no label of its own ("sends command to"),
 * worded once for the canvas, the exporter and routing. Routing needs it too: where a caption lands
 * is decided with its size in view, so it clears the shapes, bends and arrowhead around it.
 *
 * `unusual` marks an architecturally unusual pairing, which the caption flags with a leading `▲`.
 */
export function connectorCaptionText(
  edge: Pick<DraftEdge, 'semantic' | 'hasResponse' | 'deliveryAttempts' | 'compensationFor' | 'compensationName'>,
  source: NodeCategory | undefined,
  target: NodeCategory | undefined,
): { text: string; unusual: boolean } | null {
  if (!edge.semantic) return null;
  const status = source && target ? capabilityFor(source, target)?.status : undefined;
  const unusual = status === 'unusual' || status === 'questionable';
  const caption = compensationActionCaption(edge.compensationFor ? edge.compensationName : undefined, relationshipCaptionLabel(edge.semantic, {
    hasResponse: edge.hasResponse,
    deliveryAttempts: edge.deliveryAttempts,
    source,
    target,
  }));
  return { text: unusual ? `▲ ${caption}` : caption, unusual };
}
