import type { Edge, Node } from '@xyflow/react';
import type { DraftDocument, DraftNode } from '../document/types';

/**
 * Projects the document into the arrays React Flow renders.
 *
 * Two rules make this cheap. First, `data` carries nothing but the node id:
 * node components read their own state from the store, so editing one node's
 * text does not touch the projected array at all and re-renders exactly one
 * component. Second, projection preserves object identity for nodes whose
 * geometry has not changed, so React Flow skips them.
 */
export type DraftNodeData = { id: string };
export type DraftRfNode = Node<DraftNodeData>;
export type DraftRfEdge = Edge<{ id: string }>;

export const NODE_COMPONENT = 'draft';
export const EDGE_COMPONENT = 'draft';

/** Boundaries always sit behind their contents, whatever their z value. */
function zIndexOf(node: DraftNode): number {
  return node.type === 'group' ? node.z - 1000 : node.z;
}

function isSameGeometry(a: DraftRfNode, node: DraftNode, selected: boolean): boolean {
  return (
    a.position.x === node.x &&
    a.position.y === node.y &&
    a.width === node.width &&
    a.height === node.height &&
    a.zIndex === zIndexOf(node) &&
    a.selected === selected &&
    a.draggable !== undefined
  );
}

export interface ProjectionOptions {
  selectedNodes: ReadonlySet<string>;
  selectedEdges: ReadonlySet<string>;
  interactive: boolean;
}

export function projectNodes(
  document: DraftDocument,
  previous: readonly DraftRfNode[],
  options: ProjectionOptions,
): DraftRfNode[] {
  const before = new Map(previous.map((node) => [node.id, node]));
  let changed = previous.length !== document.nodes.length;

  const projected = document.nodes.map((node) => {
    const selected = options.selectedNodes.has(node.id);
    const existing = before.get(node.id);
    if (
      existing &&
      existing.draggable === options.interactive &&
      isSameGeometry(existing, node, selected)
    ) {
      return existing;
    }
    changed = true;
    return {
      id: node.id,
      type: NODE_COMPONENT,
      position: { x: node.x, y: node.y },
      width: node.width,
      height: node.height,
      zIndex: zIndexOf(node),
      selected,
      draggable: options.interactive,
      selectable: options.interactive,
      connectable: options.interactive,
      data: { id: node.id },
    } satisfies DraftRfNode;
  });

  return changed ? projected : (previous as DraftRfNode[]);
}

export function projectEdges(
  document: DraftDocument,
  previous: readonly DraftRfEdge[],
  options: ProjectionOptions,
): DraftRfEdge[] {
  const before = new Map(previous.map((edge) => [edge.id, edge]));
  let changed = previous.length !== document.edges.length;

  const projected = document.edges.map((edge) => {
    const selected = options.selectedEdges.has(edge.id);
    const existing = before.get(edge.id);
    if (
      existing &&
      existing.selected === selected &&
      existing.source === edge.source &&
      existing.target === edge.target &&
      existing.selectable === options.interactive
    ) {
      return existing;
    }
    changed = true;
    return {
      id: edge.id,
      type: EDGE_COMPONENT,
      source: edge.source,
      target: edge.target,
      selected,
      selectable: options.interactive,
      focusable: options.interactive,
      // Geometry is derived by the edge component from live node rectangles, so
      // nothing about the shape of the connector is carried here.
      data: { id: edge.id },
    } satisfies DraftRfEdge;
  });

  return changed ? projected : (previous as DraftRfEdge[]);
}
