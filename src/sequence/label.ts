/**
 * Message-label resolution for the Sequence Diagram — a thin extension of
 * `document/edgeSemantics.ts`'s existing "richest available label" priority, not a parallel
 * scheme. Draft Canvas already knows how to caption a connector; this just adds one more fallback
 * tier for the case a caption function alone can't cover (an edge with no `semantic` at all),
 * before falling back to a bare generic word.
 */
import { capabilityFor, type NodeCategory } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { EdgeSemantic } from '../document/types';
import type { InteractionKind } from './types';

const GENERIC_FALLBACK: Record<InteractionKind, string> = {
  sync: 'Call',
  async: 'Event',
  response: 'Response',
};

export interface LabelableEdge {
  label?: string;
  semantic?: EdgeSemantic;
  hasResponse?: boolean;
  deliveryAttempts?: number;
}

/**
 * The request/primary leg's label. Priority: (1) the edge's own explicit `label`; (2) its
 * `semantic`, formatted through the same `relationshipCaptionLabel` every connector caption
 * already uses (so a request/response pairing still reads "requests", a dead-letter route still
 * reads "after N attempts"); (3) when `semantic` is unset, the capability matrix's own
 * `defaultRelation` for this pairing — an *inferred*, non-persisted hint, formatted the same way;
 * (4) a bare generic bucket word, only when the matrix has no opinion at all (an unlisted category
 * pairing, e.g. touching a decorative node).
 */
export function resolveMessageLabel(
  edge: LabelableEdge,
  sourceCategory: NodeCategory,
  targetCategory: NodeCategory,
  interaction: InteractionKind,
): string {
  const explicit = edge.label?.trim();
  if (explicit) return explicit;
  if (edge.semantic) return relationshipCaptionLabel(edge.semantic, edge.hasResponse, edge.deliveryAttempts);
  const inferred = capabilityFor(sourceCategory, targetCategory)?.defaultRelation;
  if (inferred) return relationshipCaptionLabel(inferred, edge.hasResponse, edge.deliveryAttempts);
  return GENERIC_FALLBACK[interaction];
}

/**
 * The synthesized response leg's label — a separate, simpler chain than the request's: the edge's
 * own explicit `response` text, else the generic `'Response'` fallback. Never runs the request
 * leg's tiers above — `relationshipCaptionLabel`'s "requests" wording describes the *request*, not
 * the reply.
 */
export function resolveResponseLabel(response: string | undefined): string {
  return response?.trim() || GENERIC_FALLBACK.response;
}

const ASYNC_SEMANTICS: ReadonlySet<EdgeSemantic> = new Set([
  'publishes',
  'consumes',
  'deliversTo',
  'fansOut',
  'deadLetters',
]);

/** Which of the three message buckets an edge's *request* leg belongs to. The synthesized
 *  response leg is always `'response'` and never goes through this function. `kind === 'async'`
 *  and `kind === 'event'` both count (a user picking either from the "Flow kind" dropdown is
 *  stating asynchronous intent even if they've since detached the line's own dash pattern via
 *  `async` — see `ConnectorKind`'s doc comment on the two fields being independently toggleable). */
export function interactionKindFor(edge: { semantic?: EdgeSemantic; kind?: string; async?: boolean }): InteractionKind {
  if (
    (edge.semantic && ASYNC_SEMANTICS.has(edge.semantic)) ||
    edge.kind === 'event' ||
    edge.kind === 'async' ||
    edge.async === true
  ) {
    return 'async';
  }
  return 'sync';
}
