import { categoryOf } from '../document/connectorSemantics';
import type { DraftDocument } from '../document/types';
import type { Neighborhood } from './types';

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
