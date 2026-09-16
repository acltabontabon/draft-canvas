import { categoryOf } from '../document/connectorSemantics';
import type { DraftDocument, DraftNodeType, ViewLevel } from '../document/types';
import type { IncidentEdge, Neighborhood } from './types';

/** Node types a continuation can hang off — or connect to. Annotations, boundaries and routing
 *  points never do. */
export const ANCHOR_TYPES: ReadonlySet<DraftNodeType> = new Set<DraftNodeType>(['service', 'database', 'queue', 'actor', 'component']);

/**
 * One node, its one-hop surroundings, and the connectors leaving its outbound neighbors — the only
 * graph context a rule is ever given. At most two passes over the edges; nothing is indexed,
 * memoized, or walked further, so the cost is trivially bounded and there is nothing to invalidate.
 *
 * Returns `undefined` when the node does not exist.
 */
export function neighborhoodOf(
  doc: DraftDocument,
  nodeId: string,
  /** What this view is showing, where that is known — see `src/depth/level.ts`. Passed in rather
   *  than read off the document, because the level in force may be the one the room outside hands
   *  down, which only the caller can work out. */
  level?: ViewLevel,
): Neighborhood | undefined {
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
  const outOfOut = new Map<string, IncidentEdge[]>();
  if (out.length > 0) {
    for (const { other } of out) outOfOut.set(other.id, []);
    for (const edge of doc.edges) {
      const bucket = outOfOut.get(edge.source);
      const other = bucket && edge.target !== nodeId ? byId.get(edge.target) : undefined;
      if (bucket && other) bucket.push({ edge, other, category: categoryOf(other) });
    }
  }
  const category = categoryOf(node);
  return { node, category, out, in: incoming, outOfOut, level, key: neighborhoodKey(category, out, incoming) };
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
