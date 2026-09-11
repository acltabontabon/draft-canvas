/**
 * Junction flattening for the Sequence Diagram.
 *
 * A Junction (`type: 'ellipse'`) is a pure canvas routing/convergence primitive with no semantic
 * identity of its own (see `docs/SEMANTICS.md`'s "Junctions are semantics-transparent") — it must
 * never become a sequence participant on its own. A path like `Service A → Junction → Service B`
 * is really one interaction and must flatten into one `SequenceMessage`, without losing whichever
 * edge's label/semantics is most meaningful.
 */
import { categoryOf, resolveJunctionEndpoint, type GraphLike } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftDocument, DraftEdge, DraftFlow } from '../document/types';
import { resolveFlowStep } from '../presentation/useFlowPlayback';

/** One edge, in flow order, tagged with the step it came from. */
interface Hop {
  edge: DraftEdge;
  stepId: string;
}

/** A run of hops flattened into a single message — length 1 outside junction chains. */
export interface MessageChain {
  edges: DraftEdge[];
  stepIds: string[];
}

export interface ResolvedEndpoint {
  nodeId: string;
  isJunctionFallback: boolean;
}

/**
 * The flow's edges, in order, one hop per edge a step lights up — `[edgeId, ...extraEdgeIds]`
 * order within a step, steps in `flow.steps` array order. Reuses `resolveFlowStep`
 * (`presentation/useFlowPlayback.ts`), the existing "interpret a flow step" primitive, rather than
 * re-deriving step resolution: a pure frame step (no edgeId, no extraEdgeIds) naturally resolves to
 * an empty `edges` array there and contributes nothing here, with no special-casing needed.
 */
export function buildHopList(doc: DraftDocument, flow: DraftFlow): Hop[] {
  const edgesById = new Map(doc.edges.map((e) => [e.id, e]));
  const nodesById = new Map(doc.nodes.map((n) => [n.id, n]));
  const hops: Hop[] = [];
  flow.steps.forEach((step, index) => {
    const resolved = resolveFlowStep(step, index, index, edgesById, nodesById);
    if (!resolved) return;
    for (const edge of resolved.edges) hops.push({ edge, stepId: step.id });
  });
  return hops;
}

/**
 * Groups consecutive hops into chains by literal graph adjacency *through a Junction node* —
 * never by coincidentally-matching endpoints. A hop joins the current chain only when the chain's
 * last edge targets a node that is actually a Junction (`categoryOf(node) === 'junction'`, not
 * merely an id match) and this hop's edge originates from that exact same node; otherwise the
 * chain flushes and a new one starts. This is a structural check, not a heuristic: two ordinary,
 * non-Junction steps that happen to chain (A→B then B→C, both real services) are never merged —
 * only a genuine Junction crossing is — and a Junction crossed twice with unrelated steps in
 * between produces two separate messages.
 */
export function groupChains(graph: GraphLike, hops: Hop[]): MessageChain[] {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const isJunction = (nodeId: string) => {
    const node = nodesById.get(nodeId);
    return node !== undefined && categoryOf(node) === 'junction';
  };

  const chains: MessageChain[] = [];
  let current: Hop[] = [];
  for (const hop of hops) {
    const last = current[current.length - 1];
    const adjacentThroughJunction =
      last !== undefined && last.edge.target === hop.edge.source && isJunction(last.edge.target);
    if (current.length > 0 && !adjacentThroughJunction) {
      chains.push({ edges: current.map((h) => h.edge), stepIds: current.map((h) => h.stepId) });
      current = [];
    }
    current.push(hop);
  }
  if (current.length > 0) chains.push({ edges: current.map((h) => h.edge), stepIds: current.map((h) => h.stepId) });
  return chains;
}

/**
 * Resolves one side of a chain to its real participant node — `resolveJunctionEndpoint` already
 * returns the node unchanged (`status: 'resolved'`) for a non-Junction node, so this needs no
 * upfront category check of its own. `'unresolved'`/`'ambiguous'` surface the Junction itself
 * (the deliberate, documented V1 exception: an ambiguous fan-in or a dangling side cannot be
 * losslessly flattened to one real node without fabricating one).
 */
function resolveEndpoint(graph: GraphLike, nodeId: string, role: 'source' | 'target'): ResolvedEndpoint {
  const result = resolveJunctionEndpoint(graph, nodeId, role);
  return { nodeId: result.nodeId, isJunctionFallback: result.status !== 'resolved' };
}

/**
 * A chain's outer endpoints, resolved against the *whole document graph* — not just the flow's
 * own steps — since a Junction's other leg need not itself be a member of any flow.
 */
export function resolveChainEndpoints(
  doc: DraftDocument,
  chain: MessageChain,
): { source: ResolvedEndpoint; target: ResolvedEndpoint } {
  const first = chain.edges[0]!;
  const last = chain.edges[chain.edges.length - 1]!;
  return {
    source: resolveEndpoint(doc, first.source, 'source'),
    target: resolveEndpoint(doc, last.target, 'target'),
  };
}

/**
 * The chain's representative edge for label/semantic/`hasResponse`/`response`/`kind`/`async`/
 * `deliveryAttempts` — every behavioral flag on the emitted message comes from this one edge,
 * never merged across the chain (merging would misrepresent which physical connector actually
 * carries e.g. a response line). Priority: an edge with a non-empty explicit `label`, else one
 * with a defined `semantic`, else the chain's first edge.
 */
export function pickRepresentativeEdge(edges: DraftEdge[]): DraftEdge {
  const labeled = edges.find((e) => e.label?.trim());
  if (labeled) return labeled;
  const withSemantic = edges.find((e) => e.semantic !== undefined);
  if (withSemantic) return withSemantic;
  return edges[0]!;
}

/** Display name for a resolved endpoint — `displayNameFor` already renders `'Junction'` for an
 *  unlabeled ellipse, so the Junction-fallback case needs no special handling here. */
export function nameForEndpoint(doc: DraftDocument, endpoint: ResolvedEndpoint): string {
  const node = doc.nodes.find((n) => n.id === endpoint.nodeId);
  return node ? displayNameFor(node) : 'Untitled';
}
