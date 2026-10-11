import { canCreateInside, embed, viewOf, walkGraphs, type DepthPath } from '../depth/tree';
import { descendantsOf } from '../document/operations';
import { LIMITS } from '../document/limits';
import type { DraftDocument } from '../document/types';
import { AgentError } from './errors';

/** Move a subgraph inward, preserving identities. Mixed-view stories require an explicit edit first. */
export function moveInside(file: DraftDocument, path: DepthPath, ownerId: unknown, rawIds: unknown): DraftDocument {
  const view = viewOf(file, path);
  const owner = view?.nodes.find((n) => n.id === ownerId);
  if (!view || !owner || !canCreateInside(owner)) throw new AgentError('INVALID_REFERENCE', 'owner must be a service or component in this view.');
  if (path.length >= LIMITS.maxInsideDepth) throw new AgentError('LIMIT_EXCEEDED', 'The diagram is already at its maximum inside depth.');
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 300 || rawIds.some((id) => typeof id !== 'string' || !view.nodes.some((n) => n.id === id))) throw new AgentError('INVALID_REFERENCE', 'ids must name 1–300 shapes in this view.');
  const ids = new Set<string>(rawIds);
  for (const id of [...ids]) for (const child of descendantsOf(view, id)) ids.add(child);
  if (ids.has(owner.id)) throw new AgentError('CONTAINMENT_CYCLE', 'The owner cannot be moved inside itself or one of its descendants.');
  for (const node of view.nodes.filter((n) => ids.has(n.id))) walkGraphs({ ...file, nodes: [node], edges: [], flows: [] }, (_graph, nested) => {
    if (path.length + 1 + nested.length > LIMITS.maxInsideDepth) throw new AgentError('LIMIT_EXCEEDED', 'Moving this subtree would exceed the maximum inside depth.');
  });
  const innerEdges = view.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const edgeIds = new Set(innerEdges.map((e) => e.id));
  const innerFlows = view.flows.filter((f) => f.steps.length && f.steps.every((s) => !!s.edgeId && edgeIds.has(s.edgeId) && (s.extraNodeIds ?? []).every((id) => ids.has(id)) && (s.extraEdgeIds ?? []).every((id) => edgeIds.has(id))));
  const flowIds = new Set(innerFlows.map((f) => f.id));
  for (const flow of view.flows) {
    const touches = flow.steps.some((s) => (s.edgeId && edgeIds.has(s.edgeId)) || s.extraNodeIds?.some((id) => ids.has(id)) || s.extraEdgeIds?.some((id) => edgeIds.has(id)));
    if (touches && !flowIds.has(flow.id)) throw new AgentError('UNSUPPORTED', `Flow "${flow.title}" spans the overview and the detail. Explicitly split that story before moving its shapes.`, { details: { flow: flow.id } });
    if (flow.variantOf && flowIds.has(flow.id) !== flowIds.has(flow.variantOf)) throw new AgentError('UNSUPPORTED', 'A flow and its variants must stay in the same view.');
  }
  const outerEdges = view.edges.filter((e) => !edgeIds.has(e.id)).map((edge) => {
    if (!ids.has(edge.source) && !ids.has(edge.target)) return edge;
    const source = ids.has(edge.source) ? owner.id : edge.source;
    const target = ids.has(edge.target) ? owner.id : edge.target;
    if (source === target) throw new AgentError('UNSUPPORTED', `Relationship "${edge.id}" would become a self-loop at the overview. Edit it explicitly before moving its shapes.`);
    return { ...edge, source, target, sourceAnchor: undefined, targetAnchor: undefined, routing: 'smoothstep' as const };
  });
  const pairs = new Set<string>();
  for (const edge of outerEdges) {
    const pair = `${edge.source}|${edge.target}|${edge.semantic === 'compensates' ? 'compensation' : 'normal'}`;
    if (pairs.has(pair)) throw new AgentError('UNSUPPORTED', 'Moving these shapes would merge distinct overview relationships. Consolidate them explicitly first.');
    pairs.add(pair);
  }
  const childPath = [...path, owner.id];
  const inside = viewOf(file, childPath)!;
  const movedNodes = view.nodes.filter((n) => ids.has(n.id)).map((n) => n.parentId && !ids.has(n.parentId) ? { ...n, parentId: undefined } : n);
  const outer = { ...view, nodes: view.nodes.filter((n) => !ids.has(n.id)), edges: outerEdges, flows: view.flows.filter((f) => !flowIds.has(f.id)) };
  const without = path.length ? embed(file, path, outer) : outer;
  return embed(without, childPath, { ...inside, nodes: [...inside.nodes, ...movedNodes], edges: [...inside.edges, ...innerEdges], flows: [...inside.flows, ...innerFlows] });
}
