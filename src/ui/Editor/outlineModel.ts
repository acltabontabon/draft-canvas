import { displayNameFor } from '../../document/factory';
import type { DraftEdge, DraftNode } from '../../document/types';
import { count } from '../../lib/plural';
import { connectorReading, connectorText, kindReading, nodeLookupOf, nodeReading } from '../../nodes/readings';

/**
 * The Outline's rows — the room as a tree, in reading order, with no React in it so the shape of
 * the list can be tested on its own.
 *
 * Boundaries hold their members; every shape holds the connectors that touch it, so a connector
 * appears under both of its ends (as "→ Orders" under the sender and "← Orders API" under the
 * receiver). Order is top-to-bottom, then left-to-right — the order the eye takes across the
 * picture, so a listener and a viewer walk the same path.
 */
export interface OutlineRow {
  /** Unique within the tree; a connector's key carries the shape it is listed under. */
  key: string;
  kind: 'node' | 'edge';
  /** The element's own id — shared by a connector's two rows. */
  id: string;
  /** 1-based, for `aria-level`. */
  depth: number;
  parentKey: string | null;
  childKeys: string[];
  /** What the row shows. */
  label: string;
  /** Quieter text after the label: a shape's kind, or a connector's caption. */
  detail?: string;
  /** What the row says — its `aria-label`. */
  reading: string;
  direction?: 'out' | 'in' | 'both';
}

function readingOrder(a: DraftNode, b: DraftNode): number {
  return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}

export function nodeKey(id: string): string {
  return `n:${id}`;
}

export function edgeKey(edgeId: string, underNodeId: string): string {
  return `e:${edgeId}@${underNodeId}`;
}

export function buildOutline(room: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }): OutlineRow[] {
  const lookup = nodeLookupOf(room.nodes);
  const members = new Map<string, DraftNode[]>();
  const roots: DraftNode[] = [];
  for (const node of room.nodes) {
    // A parent that is not in this room (a stale id) does not hide its member: the shape is listed at
    // the top, which is where the canvas draws it too.
    if (node.parentId && lookup(node.parentId)) {
      const list = members.get(node.parentId) ?? [];
      list.push(node);
      members.set(node.parentId, list);
    } else roots.push(node);
  }

  const touching = new Map<string, DraftEdge[]>();
  for (const edge of room.edges) {
    for (const end of edge.source === edge.target ? [edge.source] : [edge.source, edge.target]) {
      const list = touching.get(end) ?? [];
      list.push(edge);
      touching.set(end, list);
    }
  }

  const rows: OutlineRow[] = [];
  const visit = (node: DraftNode, depth: number, parentKey: string | null) => {
    const key = nodeKey(node.id);
    const edges = touching.get(node.id) ?? [];
    const row: OutlineRow = {
      key,
      kind: 'node',
      id: node.id,
      depth,
      parentKey,
      childKeys: [],
      label: displayNameFor(node),
      detail: kindReading(node),
      reading: `${nodeReading(node)}, ${count(edges.length, 'connector')}`,
    };
    rows.push(row);
    for (const edge of edges) {
      const outgoing = edge.source === node.id;
      const otherId = outgoing ? edge.target : edge.source;
      const other = lookup(otherId);
      const otherName = other ? displayNameFor(other) : 'somewhere';
      const edgeRow: OutlineRow = {
        key: edgeKey(edge.id, node.id),
        kind: 'edge',
        id: edge.id,
        depth: depth + 1,
        parentKey: key,
        childKeys: [],
        label: otherName,
        detail: connectorText(edge, lookup(edge.source), lookup(edge.target)),
        reading: connectorReading(edge, lookup),
        direction: !edge.directed ? 'both' : outgoing ? 'out' : 'in',
      };
      row.childKeys.push(edgeRow.key);
      rows.push(edgeRow);
    }
    for (const member of [...(members.get(node.id) ?? [])].sort(readingOrder)) {
      row.childKeys.push(nodeKey(member.id));
      visit(member, depth + 1, key);
    }
  };
  for (const root of [...roots].sort(readingOrder)) visit(root, 1, null);
  return rows;
}

/**
 * The row the canvas selection points at — the first selected shape, else the first selected
 * connector. A connector has two rows (one under each end); `preferred` — the row the keyboard is
 * on — wins when it is one of them, so arrowing onto a connector's row does not jump the stop to its
 * twin under the other shape.
 */
export function rowKeyForSelection(
  selection: { nodes: readonly string[]; edges: readonly string[] },
  rows: readonly OutlineRow[],
  preferred: string | null = null,
): string | null {
  const node = selection.nodes[0];
  if (node) return rows.some((row) => row.key === nodeKey(node)) ? nodeKey(node) : null;
  const edge = selection.edges[0];
  if (edge) {
    const twins = rows.filter((row) => row.kind === 'edge' && row.id === edge);
    return twins.find((row) => row.key === preferred)?.key ?? twins[0]?.key ?? null;
  }
  return null;
}
