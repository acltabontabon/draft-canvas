import { canCreateInside, embed, viewOf, walkGraphs, type DepthPath } from '../depth/tree';
import { freeOriginFor } from '../document/geometry';
import { descendantsOf } from '../document/operations';
import { LIMITS } from '../document/limits';
import { reinferIfEligible } from '../document/reinfer';
import type { DraftDocument, DraftEdge } from '../document/types';
import { assignAnchors } from '../layout/anchors';
import type { DescribeContext } from '../nodes/describe';
import { AgentError } from './errors';
import { fitGroups } from './arrange';
import { anchorRectOf, captionSizer, placeBlock } from './place';
import { checkQuality, isBetterReport, isClean, type QualityReport } from './quality';
import { repairAnchors } from './route';

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

/**
 * The inverse of `moveInside`: shapes in an inside view move out to the view around it, keeping their
 * ids, attachments, the connectors among them and the flows told entirely with them. A connector from
 * one of them to a shape that stays inside now starts or ends at the owner — the shape whose inside
 * it was — which is how the outer view draws everything inside it. The moved shapes keep their
 * arrangement and are set beside the owner; nothing already in the outer view moves. A story that
 * spans what moves and what stays, or two connectors that would merge, is refused, never trimmed.
 */
export function moveOutside(
  file: DraftDocument,
  path: DepthPath,
  rawIds: unknown,
  ctx: DescribeContext,
  direction: 'right' | 'down',
): { file: DraftDocument; touched: Set<string>; advisories: string[] } {
  if (path.length === 0) throw new AgentError('UNSUPPORTED', 'The top view has no view outside it. moveOutside moves shapes out of an inside view: pass view.inside.');
  const view = viewOf(file, path);
  const parentPath = path.slice(0, -1);
  const parent = viewOf(file, parentPath);
  const owner = parent?.nodes.find((n) => n.id === path[path.length - 1]);
  if (!view || !parent || !owner) throw new AgentError('NOT_FOUND', 'That view no longer exists.');
  if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 300 || rawIds.some((id) => typeof id !== 'string' || !view.nodes.some((n) => n.id === id))) throw new AgentError('INVALID_REFERENCE', 'ids must name 1–300 shapes in this view.');
  const ids = new Set<string>(rawIds);
  for (const id of [...ids]) for (const child of descendantsOf(view, id)) ids.add(child);

  const innerEdges = view.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const crossing = view.edges.filter((e) => ids.has(e.source) !== ids.has(e.target));
  const movedEdgeIds = new Set([...innerEdges, ...crossing].map((e) => e.id));
  const movedFlows = view.flows
    .filter((f) => f.steps.length && f.steps.every((s) => (!s.edgeId || movedEdgeIds.has(s.edgeId)) && (s.extraNodeIds ?? []).every((id) => ids.has(id)) && (s.extraEdgeIds ?? []).every((id) => movedEdgeIds.has(id))) && f.steps.some((s) => s.edgeId || s.extraNodeIds?.length))
    // A camera pinned in the inside view frames nothing in the outer one: the presentation fits the step instead.
    .map((f) => ({ ...f, steps: f.steps.map(({ viewport: _pinned, ...step }) => step) }));
  const flowIds = new Set(movedFlows.map((f) => f.id));
  for (const flow of view.flows) {
    const touches = flow.steps.some((s) => (s.edgeId && movedEdgeIds.has(s.edgeId)) || s.extraNodeIds?.some((id) => ids.has(id)) || s.extraEdgeIds?.some((id) => movedEdgeIds.has(id)));
    if (touches && !flowIds.has(flow.id)) throw new AgentError('UNSUPPORTED', `Flow "${flow.title}" is told with shapes that stay inside as well as ones that move out. Split that story explicitly before moving its shapes.`, { details: { flow: flow.id } });
    if (flow.variantOf && flowIds.has(flow.id) !== flowIds.has(flow.variantOf)) throw new AgentError('UNSUPPORTED', 'A flow and its variants must stay in the same view.');
  }
  const taken = new Set(parent.flows.map((f) => f.title.trim().toLowerCase()));
  const clash = movedFlows.find((f) => taken.has(f.title.trim().toLowerCase()));
  if (clash) throw new AgentError('DUPLICATE_FLOW', `The outer view already has a flow called "${clash.title}". Rename one of them first.`, { details: { flow: clash.id } });

  // A connector to a shape that stays inside now meets the owner, as everything inside it does outside.
  const redirected = crossing.map((edge): DraftEdge => {
    const moved: DraftEdge = { ...edge, source: ids.has(edge.source) ? edge.source : owner.id, target: ids.has(edge.target) ? edge.target : owner.id, routing: 'smoothstep' };
    delete moved.sourceAnchor;
    delete moved.targetAnchor;
    return moved;
  });
  const pairs = new Set(parent.edges.map((e) => `${e.source}|${e.target}|${e.semantic === 'compensates' ? 'compensation' : 'normal'}`));
  for (const edge of redirected) {
    const pair = `${edge.source}|${edge.target}|${edge.semantic === 'compensates' ? 'compensation' : 'normal'}`;
    if (pairs.has(pair)) throw new AgentError('UNSUPPORTED', `Relationship "${edge.id}" would merge with one the outer view already has between "${edge.source}" and "${edge.target}". Consolidate them explicitly first.`, { details: { relationship: edge.id } });
    pairs.add(pair);
  }

  const room = { ...view, nodes: view.nodes.filter((n) => !ids.has(n.id)), edges: view.edges.filter((e) => !movedEdgeIds.has(e.id)), flows: view.flows.filter((f) => !flowIds.has(f.id)) };
  const emptied = embed(file, path, room);
  const around = viewOf(emptied, parentPath)!;
  const touched = new Set<string>([...ids, ...movedEdgeIds, owner.id]);
  // A boundary that grows to hold what moves is judged with it: grown into a neighbour, it is refused
  // (LAYOUT_CONSTRAINED, with the arrange that makes room), as an addition's would be.
  for (let at = owner.parentId; at && !touched.has(at); at = around.nodes.find((n) => n.id === at)?.parentId) touched.add(at);

  // The moved shapes keep their arrangement and are set beside the owner as one block. One level up,
  // a shape that was inside the owner is still inside whatever boundary holds the owner — a component
  // lifted out of a container stays in that container's system — and the boundary grows to hold it.
  const moving = view.nodes.filter((n) => ids.has(n.id));
  const minX = Math.min(...moving.map((n) => n.x));
  const minY = Math.min(...moving.map((n) => n.y));
  const size = { width: Math.max(...moving.map((n) => n.x + n.width)) - minX, height: Math.max(...moving.map((n) => n.y + n.height)) - minY };
  const group = owner.parentId;
  const at = (origin: { x: number; y: number }, dir: 'right' | 'down', into: string | undefined): DraftDocument => {
    const movedNodes = moving.map((n) => {
      const placed = { ...n, x: Math.round(n.x - minX + origin.x), y: Math.round(n.y - minY + origin.y) };
      if (!placed.parentId || !ids.has(placed.parentId)) {
        if (into) placed.parentId = into;
        else delete placed.parentId;
      }
      return placed;
    });
    let next: DraftDocument = { ...around, nodes: [...around.nodes, ...movedNodes], edges: [...around.edges, ...innerEdges, ...redirected], flows: [...around.flows, ...movedFlows] };
    if (into) for (const node of movedNodes.filter((n) => n.parentId === into)) next = fitGroups(next, node.id);
    // A connector whose end changed is a re-pointed connector: its inferred meaning follows its new
    // end, and it is anchored from where both shapes are now.
    for (const edge of redirected) next = reinferIfEligible(next, edge.id, view);
    const fresh = next.edges.filter((e) => redirected.some((r) => r.id === e.id)).map((e) => ({ ...e }));
    const anchors = assignAnchors(fresh, new Map(next.nodes.map((n) => [n.id, anchorRectOf(n)])), dir);
    for (const edge of fresh) Object.assign(edge, anchors.get(edge.id) ?? {});
    const edges = next.edges.map((e) => fresh.find((f) => f.id === e.id) ?? e);
    repairAnchors(fresh, next.nodes, captionSizer(next.nodes, ctx), edges);
    return { ...next, edges: next.edges.map((e) => fresh.find((f) => f.id === e.id) ?? e) };
  };
  // Beside the owner, in the reading direction and across it, the first readable spot kept — the way
  // an addition is placed (`addToView`). Inside the owner's boundary first; when that boundary can't
  // grow without running into a neighbour, just outside it (said so), rather than refusing a move a
  // later arrange of the outer view can tidy. Nowhere free beside the owner: after what is there.
  const other = direction === 'right' ? 'down' : 'right';
  const spots = [...(group ? [group] : []), undefined].flatMap((into) =>
    ([direction, other] as const).flatMap((dir) => {
      const origin = placeBlock(around, owner, size, dir, into);
      return origin ? [{ origin, dir, into }] : [];
    }),
  );
  spots.push({ origin: freeOriginFor(around, size), dir: direction, into: undefined });
  let best: { view: DraftDocument; report: QualityReport; into: string | undefined } | undefined;
  for (const spot of spots) {
    const candidate = at(spot.origin, spot.dir, spot.into);
    const report = checkQuality(candidate.nodes, candidate.edges, ctx, touched);
    if (!best || isBetterReport(report, best.report)) best = { view: candidate, report, into: spot.into };
    if (isClean(report)) break;
  }
  const next = best!.view;
  const advisories = group && best!.into !== group
    ? [`The shapes moved out of "${owner.id}" were placed outside boundary "${group}", which had no room for them; arrange the outer view, then set their group to "${group}" to bring them in.`]
    : [];
  return { file: parentPath.length ? embed(emptied, parentPath, next) : next, touched, advisories };
}
