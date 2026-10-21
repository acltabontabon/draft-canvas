/**
 * A connector's two routes — the request line and, for a request/response connector, its reply —
 * worked out once and shared by everything that needs them: the canvas drawing it
 * (`canvas/DraftEdgeView.tsx`), the crossing plan finding where it crosses others (`crossings.ts`)
 * and label grouping checking where its chip lands (`labelGroups.ts`).
 *
 * Each of those used to route every connector itself, with the same inputs under three different
 * cache keys. Opening a diagram ran the crossing plan's pass inside the first connector's render and
 * then every connector routed itself again: on a 1,000-shape diagram, a tenth of a second of the
 * open spent recomputing answers already in hand.
 *
 * Routing is pure in its inputs, so one key — every input, serialised — names one answer. Only the
 * canvas writes: an export, a preview or an agent's candidate (`PlanScope` `'transient'`) reads what
 * the canvas already worked out but never files its own routes, which would push out the ones on
 * screen.
 */
import { LIMITS } from '../document/limits';
import type { DraftPoint, EdgeAnchor, EdgeRouting } from '../document/types';
import { Lru } from '../lib/lru';
import { edgeLabelSize } from './labelLayout';
import {
  responseAwayFor,
  responseLabelAnchor,
  responseLaneFor,
  responseSpineFor,
  responseWaypointsFor,
  routeBetween,
  type EdgeSpine,
  type Rect,
  type RoutedEdge,
} from './routing';
import type { PlanScope } from './sameGeometry';

/** Everything a connector's routes depend on. */
export interface EdgeRouteInputs {
  source: Rect;
  target: Rect;
  routing: EdgeRouting;
  label: string | undefined;
  sourceAnchor: EdgeAnchor | undefined;
  targetAnchor: EdgeAnchor | undefined;
  hasResponse: boolean | undefined;
  lane: number;
  spine: EdgeSpine | undefined;
  obstacles: readonly Rect[];
  waypoints: readonly DraftPoint[] | undefined;
}

export interface EdgeRoutes {
  request: RoutedEdge;
  response: RoutedEdge | null;
  responseLabel: ReturnType<typeof responseLabelAnchor> | null;
}

/** Room for every connector a document may hold — smaller, a render that touches them all evicts
 *  routes still on screen and recomputes most of them. */
const SHARED = new Lru<string, EdgeRoutes>(LIMITS.maxEdges);

function keyOf(inputs: EdgeRouteInputs): string {
  return JSON.stringify([
    inputs.source,
    inputs.target,
    inputs.routing,
    inputs.label,
    inputs.sourceAnchor,
    inputs.targetAnchor,
    inputs.hasResponse,
    inputs.lane,
    inputs.spine,
    inputs.obstacles,
    inputs.waypoints,
  ]);
}

/** Routes a connector from scratch, exactly as both renderers draw it. Uncached: for a gesture's
 *  frames, whose inputs no later frame repeats. */
export function computeEdgeRoutes(inputs: EdgeRouteInputs): EdgeRoutes {
  const { source, target, routing, lane, spine, obstacles } = inputs;
  const waypoints = inputs.waypoints as DraftPoint[] | undefined;
  const request = routeBetween(source, target, routing, {
    anchors: { source: inputs.sourceAnchor, target: inputs.targetAnchor },
    waypoints,
    lane,
    label: inputs.label ? { ...edgeLabelSize(inputs.label), away: responseAwayFor(inputs.hasResponse, lane) } : undefined,
    obstacles,
    spine,
  });
  if (!inputs.hasResponse) return { request, response: null, responseLabel: null };
  // The reply runs target → source with the anchors swapped, a lane further out — see
  // `responseLaneFor` in `routing.ts`.
  const response = routeBetween(target, source, routing, {
    anchors: { source: inputs.targetAnchor, target: inputs.sourceAnchor },
    waypoints: responseWaypointsFor(waypoints, lane),
    lane: responseLaneFor(lane),
    obstacles,
    spine: responseSpineFor(spine),
  });
  return { request, response, responseLabel: responseLabelAnchor(request, response, source, target, lane) };
}

/** A connector's routes, from the shared cache when anything has already worked them out. */
export function edgeRoutes(inputs: EdgeRouteInputs, scope: PlanScope = 'canvas'): EdgeRoutes {
  const key = keyOf(inputs);
  const known = SHARED.get(key);
  if (known) return known;
  const routes = computeEdgeRoutes(inputs);
  if (scope === 'canvas') SHARED.set(key, routes);
  return routes;
}
