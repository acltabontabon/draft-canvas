import { findItem } from '../document/sequenceModel';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';

/**
 * Index caches keyed on the array itself, the few most recent only.
 *
 * Every node component looks itself up by id on each store change. A linear scan per component
 * would be quadratic in the node count; building the map once per document version and sharing it
 * across all of them is not.
 *
 * Not a WeakMap, which was the first version: its entries live as long as their array does, and the
 * undo history keeps one array (and so one Map) for every step it holds. Measured with the 150-step
 * history cap, that was about 4 MB at 300 shapes, 8 MB at 1,000 and 33 MB at 3,000 (nodes and
 * connectors together) for lookups nothing would ever make again. What is asked about is the document
 * on screen — a render, a gesture and the popover beside it all name the same array — plus the odd
 * neighbour (the room outside, a preview), so a handful is enough, and an older array simply gets
 * its index rebuilt if it is ever asked about again.
 */
const RECENT_INDEXES = 6;

class RecentIndexes<K extends object, V> {
  private readonly entries: { key: K; value: V }[] = [];

  get(key: K): V | undefined {
    const first = this.entries[0];
    if (first?.key === key) return first.value;
    const at = this.entries.findIndex((entry) => entry.key === key);
    if (at === -1) return undefined;
    // Most recently asked first, so the one in use is the first thing looked at.
    const [found] = this.entries.splice(at, 1);
    this.entries.unshift(found!);
    return found!.value;
  }

  set(key: K, value: V): void {
    this.entries.unshift({ key, value });
    if (this.entries.length > RECENT_INDEXES) this.entries.pop();
  }
}

const nodeIndexCache = new RecentIndexes<readonly DraftNode[], Map<string, DraftNode>>();
const edgeIndexCache = new RecentIndexes<readonly DraftEdge[], Map<string, DraftEdge>>();

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

const sequenceNodeCache = new WeakMap<readonly DraftNode[], readonly DraftNode[]>();

/**
 * The sequences among `nodes`, in node order — kept per array like the indexes above, so what asks
 * "which sequence is under this point" on every frame of a drag looks through the handful there are,
 * not through every shape on the canvas.
 */
export function sequenceNodes(nodes: readonly DraftNode[]): readonly DraftNode[] {
  const cached = sequenceNodeCache.get(nodes);
  if (cached) return cached;
  const found = nodes.filter((node) => node.type === 'sequence');
  sequenceNodeCache.set(nodes, found);
  return found;
}

export function selectNode(document: DraftDocument, id: string): DraftNode | undefined {
  return nodeIndex(document.nodes).get(id);
}

export function selectEdge(document: DraftDocument, id: string): DraftEdge | undefined {
  return edgeIndex(document.edges).get(id);
}

export function selectSequenceMessage(document: DraftDocument, nodeId: string, messageId: string) {
  const sequence = selectNode(document, nodeId)?.sequence;
  const item = sequence && findItem(sequence, messageId)?.item;
  return item?.t === 'message' ? item : undefined;
}
