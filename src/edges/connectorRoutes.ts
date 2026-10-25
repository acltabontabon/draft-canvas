/**
 * The one way to read a connector's routes: the request line and its reply as the canvas, the export
 * and the agent's checks all draw them.
 *
 * Built in two layers so the plans that look at every connector at once can read the layer below the
 * one they shape: `edgeRoutes.ts` holds the routes before separation (`rawRouteInputs` — rects, lane,
 * trunk, nearby shapes, spread ends, search budget), `separation.ts` plans parallel tracks from those,
 * and this adds the tracks. Everything that draws, measures or judges a connector reads it here.
 */
import type { DraftEdge, DraftNode } from '../document/types';
import { edgeRoutes, rawRouteInputs, type EdgeRouteInputs, type EdgeRoutes, type RouteOverrides } from './edgeRoutes';
import { separationPlan } from './separation';
import type { PlanScope } from './sameGeometry';

/**
 * A connector's route inputs, read from its document. Live geometry (`overrides`, or obstacles less
 * the shapes a gesture is moving) gets no tracks: they were planned for where the shapes rest.
 */
export function connectorRouteInputs(
  edge: DraftEdge,
  doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  scope: PlanScope,
  byId?: ReadonlyMap<string, DraftNode>,
  overrides: RouteOverrides = {},
  obstacleNodes: readonly DraftNode[] = doc.nodes,
): EdgeRouteInputs | null {
  const inputs = rawRouteInputs(edge, doc, scope, byId, overrides, obstacleNodes);
  if (!inputs || overrides.source || overrides.target || overrides.obstacles || obstacleNodes !== doc.nodes) return inputs;
  const tracks = separationPlan(doc.nodes, doc.edges, scope).tracksFor(edge.id);
  return tracks ? { ...inputs, tracks } : inputs;
}

/** A connector's routes as every renderer draws them (see `connectorRouteInputs`). */
export function connectorRoutes(
  edge: DraftEdge,
  doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  scope: PlanScope,
  byId?: ReadonlyMap<string, DraftNode>,
): EdgeRoutes | null {
  const inputs = connectorRouteInputs(edge, doc, scope, byId);
  return inputs ? edgeRoutes(inputs, scope) : null;
}
