/**
 * Route inputs for a ghost connector — Intent Continuation's offer, an agent's in-flight change, a
 * proposal's preview — built the way the canvas builds a real connector's: its parallel lane
 * (`laneIndex`), its bundle trunk (`routingPlan`), where its automatic ends were spread
 * (`endpointPlan`), the tracks its runs were moved onto (`separationPlan`), its scoped obstacles
 * (`obstaclesForEdge`), its bends and its label. A ghost routed from its anchors alone previewed a
 * bend-only change with no bends, drew parallel connectors on top of each other and a
 * request/response pair as one line; one left without the two plans drew its ends and its runs
 * where the real connector would not, and moved when the offer was accepted.
 *
 * Every plan here is `'transient'`: a preview reads what the canvas has already worked out but
 * never files plans or routes of its own, which would push out the ones on screen.
 *
 * One input is left out on purpose: whether the connector may still search for a clear line
 * (`searchAllowed`), which on a diagram of more than a few dozen connectors is a plan that routes
 * all of them. A ghost always may, and a diagram big enough to have spent its budget is not one
 * where the difference is what anyone is looking at.
 */
import { visibleEdges } from '../document/compensation';
import { categoryOf } from '../document/connectorSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { routingPlan, type RoutingPlan } from '../edges/bundles';
import { routedCaption, type EdgeRouteInputs } from '../edges/edgeRoutes';
import { endpointPlan, type EdgeSpread, type EndpointPlan } from '../edges/endpoints';
import { obstaclesForEdge } from '../edges/obstacles';
import { laneIndex, rectOf, type EdgeSpine, type LaneAssignment, type Rect } from '../edges/routing';
import { separationPlan, type EdgeTracks, type SeparationPlan } from '../edges/separation';
import { sequenceAnchorRect } from '../edges/sequenceAnchors';

/** One graph a set of ghost connectors routes through — the state they will be drawn in. */
export interface GhostGraph {
  nodes: readonly DraftNode[];
  byId: ReadonlyMap<string, DraftNode>;
  lanes: ReadonlyMap<string, LaneAssignment>;
  plan: RoutingPlan;
  /** Where the plan spread a connector's automatic ends. Worked out on first use, as is
   *  `tracksFor`: the whole diagram is planned, and a ghost that draws no connector pays nothing. */
  spreadFor(edgeId: string): EdgeSpread | undefined;
  /** The tracks a connector's runs were moved onto. */
  tracksFor(edgeId: string): EdgeTracks | undefined;
}

/** What a ghost connector routes from, beyond the edge itself — every value stable while the graph
 *  is, so a memoized `GhostEdge` re-renders only when its own route could change. */
export interface GhostRoute {
  source: DraftNode;
  target: DraftNode;
  lane: number;
  spine: EdgeSpine | undefined;
  obstacles: readonly Rect[];
  spread?: EdgeSpread;
  tracks?: EdgeTracks;
  /** The relationship caption its words are placed for, when it shows one (`routedCaption`). */
  caption?: string;
}

export function ghostGraph(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): GhostGraph {
  // What the canvas plans from: a connector folded away into its parent is not routed.
  const shown = visibleEdges(edges);
  let endpoints: EndpointPlan | undefined;
  let separation: SeparationPlan | undefined;
  return {
    nodes,
    byId: new Map(nodes.map((node) => [node.id, node])),
    lanes: laneIndex(shown),
    plan: routingPlan(nodes, shown, 'transient'),
    spreadFor: (edgeId) => (endpoints ??= endpointPlan(nodes, shown, 'transient')).spreadFor(edgeId),
    tracksFor: (edgeId) => (separation ??= separationPlan(nodes, shown, 'transient')).tracksFor(edgeId),
  };
}

/** The route context for `edge` in `graph`, or null when an endpoint isn't in it. */
export function ghostRouteFor(graph: GhostGraph, edge: DraftEdge): GhostRoute | null {
  const source = graph.byId.get(edge.source);
  const target = graph.byId.get(edge.target);
  if (!source || !target) return null;
  const spread = graph.spreadFor(edge.id);
  const tracks = graph.tracksFor(edge.id);
  const caption = routedCaption(edge, categoryOf(source), categoryOf(target));
  return {
    source,
    target,
    lane: graph.lanes.get(edge.id)?.offset ?? 0,
    spine: graph.plan.spineFor(edge.id),
    obstacles: obstaclesForEdge(graph.nodes, edge.source, edge.target, 'transient'),
    ...(spread ? { spread } : {}),
    ...(tracks ? { tracks } : {}),
    ...(caption ? { caption } : {}),
  };
}

/** `edgeRoutes`' inputs for a ghost connector — what `DraftEdgeView` passes for the same connector at rest. */
export function ghostRouteInputs(edge: DraftEdge, route: GhostRoute): EdgeRouteInputs {
  return {
    source: sequenceAnchorRect(route.source, rectOf(route.source), edge.sourceAnchor),
    target: sequenceAnchorRect(route.target, rectOf(route.target), edge.targetAnchor),
    routing: edge.routing,
    label: edge.label,
    // Its caption is placed with its size in view too, as every other renderer routes it.
    ...(route.caption ? { caption: route.caption } : {}),
    sourceAnchor: edge.sourceAnchor,
    targetAnchor: edge.targetAnchor,
    hasResponse: edge.hasResponse,
    lane: route.lane,
    spine: route.spine,
    obstacles: route.obstacles,
    waypoints: edge.waypoints,
    ...(route.spread ? { spread: route.spread } : {}),
    ...(route.tracks ? { tracks: route.tracks } : {}),
  };
}
