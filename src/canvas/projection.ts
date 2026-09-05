import type { Edge, Node } from '@xyflow/react';
import { handleIdForAnchor } from '../edges/routing';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';

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
    const sourceHandle = handleIdForAnchor(edge.sourceAnchor);
    const targetHandle = handleIdForAnchor(edge.targetAnchor);
    if (
      existing &&
      existing.selected === selected &&
      existing.source === edge.source &&
      existing.target === edge.target &&
      existing.sourceHandle === sourceHandle &&
      existing.targetHandle === targetHandle &&
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
      // React Flow's own position lookups — notably the native reconnect-drag
      // hit zones — key off these to find the right handle among a node's
      // twelve. Leaving them unset (as this used to) makes React Flow fall
      // back to an arbitrary handle, silently misplacing that hit zone; our
      // own rendering never used these, since `DraftEdgeView` computes its
      // own route from the document, which is why this went unnoticed.
      sourceHandle,
      targetHandle,
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

/**
 * Resolves which edges belong in a `Canvas.tsx` `onSelectionChange` report, given the node
 * selection that report just settled on and the one it replaces.
 *
 * React Flow's own report of *which edges* go with a given node selection keeps disagreeing
 * with itself — forever — once a marquee spans (or un-spans) two or more nodes that share an
 * edge: `Canvas.tsx`'s `onEdgesChange` only prevents its own controlled-prop patch from
 * double-applying *during* the drag, but React Flow's post-gesture bookkeeping and this app's
 * own `projectEdges` recompute can still never agree on a final answer once released, each
 * perceiving the other's patch as a further change and looping forever ("Maximum update depth
 * exceeded", crashing the whole app).
 *
 * Deriving the connected edges ourselves — filtering `document.edges` (which does not change
 * just because a render happened) for both endpoints in the *new* node set — is a value that
 * cannot itself oscillate, breaking that cycle at the source. Scoped to only where that
 * ambiguity actually exists — the new selection has more than one node, or it *shrank down
 * from* one (a marquee being released or replaced) — so an ordinary single edge click or
 * deselect, where neither side of the change is ever a multi-node selection, keeps trusting
 * React Flow's own report exactly as before; overriding it unconditionally on any node-selection
 * change previously broke that case. A *plain* node click's edges still resolve correctly under
 * this narrower rule too, since a lone selected node can never be "both endpoints" of any real
 * edge.
 */
export function resolveSelectedEdgeIds(
  nodeIds: readonly string[],
  previousNodeIds: readonly string[],
  reportedEdgeIds: readonly string[],
  documentEdges: readonly Pick<DraftEdge, 'id' | 'source' | 'target'>[],
): string[] {
  const useDerivedEdges = nodeIds.length > 1 || previousNodeIds.length > 1;
  if (!useDerivedEdges) return [...reportedEdgeIds];
  return documentEdges
    .filter((edge) => nodeIds.includes(edge.source) && nodeIds.includes(edge.target))
    .map((edge) => edge.id);
}
