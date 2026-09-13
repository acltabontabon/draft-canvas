import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';

/**
 * Index caches keyed on the array itself.
 *
 * Every node component looks itself up by id on each store change. A linear
 * scan per component would be quadratic in the node count; building the map
 * once per document version and sharing it across all of them is not. The
 * WeakMap key is the array, so a new document version rebuilds the index and
 * the old one is collected.
 */
const nodeIndexCache = new WeakMap<readonly DraftNode[], Map<string, DraftNode>>();
const edgeIndexCache = new WeakMap<readonly DraftEdge[], Map<string, DraftEdge>>();

export function nodeIndex(nodes: readonly DraftNode[]): Map<string, DraftNode> {
  const cached = nodeIndexCache.get(nodes);
  if (cached) return cached;
  const index = new Map(nodes.map((node) => [node.id, node]));
  nodeIndexCache.set(nodes, index);
  return index;
}

export function edgeIndex(edges: readonly DraftEdge[]): Map<string, DraftEdge> {
  const cached = edgeIndexCache.get(edges);
  if (cached) return cached;
  const index = new Map(edges.map((edge) => [edge.id, edge]));
  edgeIndexCache.set(edges, index);
  return index;
}

export function selectNode(document: DraftDocument, id: string): DraftNode | undefined {
  return nodeIndex(document.nodes).get(id);
}

export function selectEdge(document: DraftDocument, id: string): DraftEdge | undefined {
  return edgeIndex(document.edges).get(id);
}
