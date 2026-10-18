import type { DraftDocument, DraftEdge } from './types';

/** The same eligibility rule for the drop preview, command picker and committed operation. */
export function reconnectProblem(
  graph: Pick<DraftDocument, 'nodes' | 'edges'>,
  edge: DraftEdge,
  endpoint: 'source' | 'target',
  nodeId: string,
): 'missing' | 'self' | 'duplicate' | undefined {
  // A target deleted during a drag must never leave a dangling connector.
  if (!graph.nodes.some((node) => node.id === nodeId)) return 'missing';
  // A self-loop is not a route the canvas can draw or hit-test.
  if (nodeId === (endpoint === 'source' ? edge.target : edge.source)) return 'self';
  // Moving to an already joined pair stacks duplicate arrows. Re-siding the existing pair is
  // still allowed: a Saga's command/compensation twins must not pin each other's anchors.
  if (nodeId === edge[endpoint]) return undefined;
  const source = endpoint === 'source' ? nodeId : edge.source;
  const target = endpoint === 'target' ? nodeId : edge.target;
  return graph.edges.some((other) => other.id !== edge.id && other.source === source && other.target === target)
    ? 'duplicate'
    : undefined;
}
