import { categoryOf, resolveTransparentCategory, type NodeCategory } from '../document/connectorSemantics';
import type { DraftDocument } from '../document/types';
import type { IncidentEdge, Neighborhood } from './types';

/**
 * One node and its one-hop surroundings — the only graph context a rule is ever given. One pass
 * over the edges; nothing is indexed, memoized, or walked further, so the cost is trivially
 * bounded and there is nothing to invalidate.
 *
 * Returns `undefined` when the node does not exist.
 */
export function neighborhoodOf(doc: DraftDocument, nodeId: string): Neighborhood | undefined {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: Neighborhood['out'] = [];
  const incoming: Neighborhood['in'] = [];
  for (const edge of doc.edges) {
    if (edge.source === nodeId) {
      const other = byId.get(edge.target);
      if (other) out.push({ edge, other, category: categoryOf(other) });
    } else if (edge.target === nodeId) {
      const other = byId.get(edge.source);
      if (other) incoming.push({ edge, other, category: categoryOf(other) });
    }
  }
  const category = categoryOf(node);
  return { node, category, out, in: incoming, key: neighborhoodKey(category, out, incoming) };
}

/**
 * A fingerprint that changes exactly when something a rule could react to changes: the node's own
 * category, or the set/semantics of its incident connectors. Positions, labels and unrelated parts
 * of the diagram do not move it — a dismissal survives those, and stops surviving the moment the
 * user draws something at this node.
 */
function neighborhoodKey(
  category: string,
  out: Neighborhood['out'],
  incoming: Neighborhood['in'],
): string {
  const parts = [...out, ...incoming]
    .map(({ edge }) => `${edge.id}:${edge.source}>${edge.target}:${edge.semantic ?? ''}`)
    .sort();
  return `${category}|${parts.join(',')}`;
}

/**
 * What an incident edge's `other` node *actually is*, seeing straight through it if it is a
 * Junction — a routing point has no semantic identity of its own (see `connectorSemantics.ts`'s
 * Junction notes), so a rule whose evidence needs to know what a neighbor *really is* (not just
 * what is directly attached) must resolve through it rather than reading `IncidentEdge.category`
 * literally. `direction` is which side of `nb` the edge came from: `'out'` (an `nb.out` entry,
 * anchor → other) resolves what `other` ultimately *feeds*; `'in'` (an `nb.in` entry, other →
 * anchor) resolves what ultimately *feeds* `other`.
 *
 * A thin wrapper over `connectorSemantics.ts`'s `resolveTransparentCategory` — unused by any rule
 * today (none currently need to see past a Junction; see `rules.ts`'s Junction-hardening note) —
 * kept here as the one place a future rule that does need it should reach for, instead of
 * re-deriving the same recursion.
 */
export function resolvedNeighborCategory(doc: DraftDocument, incident: IncidentEdge, direction: 'in' | 'out'): NodeCategory {
  return resolveTransparentCategory(doc, incident.other.id, direction === 'out' ? 'target' : 'source');
}
