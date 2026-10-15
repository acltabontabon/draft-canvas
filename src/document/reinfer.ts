/**
 * Re-inferring a connector's relationship after its endpoints change — one rule for every way that
 * happens: the editor's reconnect, reverse and kind change, and an agent re-pointing a relationship.
 * Kept here rather than in the store so the agent layer (which may not import the store) gives a
 * re-pointed connector exactly the meaning a person's drag would.
 */

import {
  capabilityFor,
  categoryOf,
  inferredJunctionSemantic,
  inferRelationship,
  isEligibleForReinference,
  resolveTransparentCategory,
} from './connectorSemantics';
import { updateEdge } from './operations';
import type { DraftDocument, DraftNode } from './types';

/**
 * `inferRelationship`'s own default-relation logic, wrapped so a Junction on either end resolves
 * transparently to whatever it actually connects (`resolveTransparentCategory`) instead of ending
 * inference dead at the Junction itself — the Junction connection spec's "smart inheritance": a
 * Junction sourcing a fresh edge whose incoming edges converge on one clear `semantic`
 * (`inferredJunctionSemantic`) defaults the new edge to that same semantic (as long as it's still
 * valid for the resolved pairing), falling back to the ordinary capability default — and to no
 * default at all, same as any other unclassified pairing — when the convergence is ambiguous.
 * Used by both `connect()` and `reconnectEdge()` so a connector's semantics always resolve the
 * same way regardless of how it came to exist.
 */
export function inferRelationshipThroughJunctions(
  graph: DraftDocument,
  sourceNode: DraftNode,
  targetNode: DraftNode,
): ReturnType<typeof inferRelationship> {
  const sourceCategory = resolveTransparentCategory(graph, sourceNode.id, 'source');
  const targetCategory = resolveTransparentCategory(graph, targetNode.id, 'target');
  const capability = capabilityFor(sourceCategory, targetCategory);
  const inherited =
    categoryOf(sourceNode) === 'junction' ? inferredJunctionSemantic(graph, sourceNode.id) : undefined;
  if (inherited !== undefined && (!capability || capability.relations.includes(inherited))) {
    return { semantic: inherited, kind: capability?.defaultBehavior, async: capability?.defaultAsync };
  }
  if (!capability?.defaultRelation) return undefined;
  return { semantic: capability.defaultRelation, kind: capability.defaultBehavior, async: capability.defaultAsync };
}

/**
 * Reclassifies one edge's `semantic`/`kind` from what it now actually connects, but only when
 * `isEligibleForReinference` says nothing has explicitly claimed them — extracted from
 * `reconnectEdge`'s original post-swap block so `reverseEdge` (which changes source/target exactly
 * the same way, just both endpoints at once) can reuse the identical rule instead of leaving its own
 * copy to drift. A no-op for an edge id that no longer resolves, or one whose endpoints don't (both
 * genuinely impossible via `apply`'s own recipes, but a pure function shouldn't assume its caller
 * always hands it a fully-linked graph).
 */
export function reinferIfEligible(doc: DraftDocument, edgeId: string, before?: DraftDocument): DraftDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge || !isEligibleForReinference(edge)) return doc;
  const sourceNode = doc.nodes.find((n) => n.id === edge.source);
  const targetNode = doc.nodes.find((n) => n.id === edge.target);
  if (!sourceNode || !targetNode) return doc;
  const relationship = inferRelationshipThroughJunctions(doc, sourceNode, targetNode);
  // The one case `async` may be switched *off*: inference itself dashed this line (the previous
  // pairing asked for `defaultAsync`) and the new pairing doesn't. A reversed Queue → DLQ is no
  // longer a dead-letter path, so it shouldn't keep that path's dashes. An explicit edge never
  // reaches here, so the user's own dashing is untouched.
  const priorEdge = before?.edges.find((e) => e.id === edgeId);
  const priorSource = priorEdge && before?.nodes.find((n) => n.id === priorEdge.source);
  const priorTarget = priorEdge && before?.nodes.find((n) => n.id === priorEdge.target);
  const prior =
    before && priorEdge?.semanticsOrigin === 'inferred' && priorSource && priorTarget
      ? inferRelationshipThroughJunctions(before, priorSource, priorTarget)
      : undefined;
  const dropInferredDash = Boolean(prior?.async && edge.async && !relationship?.async);
  // `hasResponse` is deliberately *absent* from this patch rather than passed
  // as `undefined`: `applyPatch` deletes keys whose value is undefined, so
  // naming it here at all would strip an explicit "Show response path" every
  // time the connector was reversed or re-pointed. Re-inference is about
  // `semantic`/`kind`; the reply line is the user's own call.
  // `async` likewise only ever *joins* the patch, never as `undefined`: the matrix asks for a
  // dashed line on a handful of pairings and has no opinion on the rest, and "no opinion" must
  // not read as "switch the user's own dashing off."
  return updateEdge(doc, edgeId, {
    semantic: relationship?.semantic,
    kind: relationship?.kind,
    semanticsOrigin: relationship ? 'inferred' : undefined,
    ...(relationship?.async ? { async: true } : dropInferredDash ? { async: undefined } : {}),
  });
}
