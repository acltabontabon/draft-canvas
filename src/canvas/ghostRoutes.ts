/**
 * Route inputs for a ghost connector — Intent Continuation's offer, an agent's in-flight change, a
 * proposal's preview — built the way the canvas builds a real connector's: its parallel lane
 * (`laneIndex`), its bundle trunk (`routingPlan`), its scoped obstacles (`obstaclesForEdge`), its
 * bends and its label. A ghost routed from its anchors alone previewed a bend-only change with no
 * bends, drew parallel connectors on top of each other and a request/response pair as one line.
 *
 * Every plan here is `'transient'`: a preview reads what the canvas has already worked out but
 * never files plans or routes of its own, which would push out the ones on screen.
 */
import type { DraftEdge, DraftNode } from '../document/types';
import { routingPlan, type RoutingPlan } from '../edges/bundles';
import type { EdgeRouteInputs } from '../edges/edgeRoutes';
import { obstaclesForEdge } from '../edges/obstacles';
import { laneIndex, rectOf, type EdgeSpine, type LaneAssignment, type Rect } from '../edges/routing';

/** One graph a set of ghost connectors routes through — the state they will be drawn in. */
export interface GhostGraph {
  nodes: readonly DraftNode[];
  byId: ReadonlyMap<string, DraftNode>;
  lanes: ReadonlyMap<string, LaneAssignment>;
  plan: RoutingPlan;
}

/** What a ghost connector routes from, beyond the edge itself — every value stable while the graph
 *  is, so a memoized `GhostEdge` re-renders only when its own route could change. */
export interface GhostRoute {
  source: DraftNode;
  target: DraftNode;
  lane: number;
  spine: EdgeSpine | undefined;
  obstacles: readonly Rect[];
}

export function ghostGraph(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): GhostGraph {
  return {
    nodes,
    byId: new Map(nodes.map((node) => [node.id, node])),
    lanes: laneIndex(edges),
    plan: routingPlan(nodes, edges, 'transient'),
  };
}

/** The route context for `edge` in `graph`, or null when an endpoint isn't in it. */
export function ghostRouteFor(graph: GhostGraph, edge: DraftEdge): GhostRoute | null {
  const source = graph.byId.get(edge.source);
  const target = graph.byId.get(edge.target);
  if (!source || !target) return null;
  return {
    source,
    target,
    lane: graph.lanes.get(edge.id)?.offset ?? 0,
    spine: graph.plan.spineFor(edge.id),
    obstacles: obstaclesForEdge(graph.nodes, edge.source, edge.target, 'transient'),
  };
}

/** `edgeRoutes`' inputs for a ghost connector — field for field what `DraftEdgeView` passes. */
export function ghostRouteInputs(edge: DraftEdge, route: GhostRoute): EdgeRouteInputs {
  return {
    source: rectOf(route.source),
    target: rectOf(route.target),
    routing: edge.routing,
    label: edge.label,
    sourceAnchor: edge.sourceAnchor,
    targetAnchor: edge.targetAnchor,
    hasResponse: edge.hasResponse,
    lane: route.lane,
    spine: route.spine,
    obstacles: route.obstacles,
    waypoints: edge.waypoints,
  };
}
