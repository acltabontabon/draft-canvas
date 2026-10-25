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
import type { DraftEdge, DraftNode, DraftPoint, EdgeAnchor, EdgeRouting } from '../document/types';
import { Lru } from '../lib/lru';
import { routingPlan } from './bundles';
import { endpointPlan, type EdgeSpread } from './endpoints';
import { edgeLabelSize } from './labelLayout';
import { obstaclesForEdge } from './obstacles';
import { MAX_POPS } from './pathfinder';
import { stepPolyline } from './waypoints';
import {
  laneIndex,
  rectOf,
  responseAwayFor,
  responseLabelAnchor,
  responseLaneFor,
  responseSpineFor,
  responseWaypointsFor,
  routeBetween,
  type EdgeSpine,
  type Rect,
  type RoutedEdge,
  type Track,
} from './routing';
import { sameNodeGeometry, type PlanScope } from './sameGeometry';

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
  /** A gesture's frame: drawn the quick way, never checked or searched (see `RouteOptions.mode`). */
  mode?: 'gesture';
  /** `false` once the diagram's search budget is spent (`searchAllowed`). */
  fallback?: boolean;
  /** Where `endpoints.ts` spread this connector's automatic ends (`RouteOptions.spread`). */
  spread?: EdgeSpread;
  /** Runs moved onto their own tracks by `separation.ts`, per line (`RouteOptions.tracks`). */
  tracks?: { request?: readonly Track[]; response?: readonly Track[] };
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
    inputs.mode ?? '',
    inputs.fallback ?? true,
    inputs.spread ?? null,
    inputs.tracks ?? null,
  ]);
}

/** Routes a connector from scratch, exactly as both renderers draw it. Uncached: for a gesture's
 *  frames, whose inputs no later frame repeats. */
export function computeEdgeRoutes(inputs: EdgeRouteInputs): EdgeRoutes {
  const { source, target, routing, lane, spine, obstacles, mode, fallback } = inputs;
  const waypoints = inputs.waypoints as DraftPoint[] | undefined;
  const request = routeBetween(source, target, routing, {
    anchors: { source: inputs.sourceAnchor, target: inputs.targetAnchor },
    waypoints,
    lane,
    label: inputs.label ? { ...edgeLabelSize(inputs.label), away: responseAwayFor(inputs.hasResponse, lane) } : undefined,
    obstacles,
    spine,
    mode,
    fallback,
    spread: inputs.spread,
    tracks: inputs.tracks?.request,
  });
  if (!inputs.hasResponse) return { request, response: null, responseLabel: null };
  // The reply runs target → source with the anchors swapped, a lane further out — see
  // `responseLaneFor` in `routing.ts`. Searched for on its own when blocked, kept apart from the
  // request line it runs beside.
  const response = routeBetween(target, source, routing, {
    anchors: { source: inputs.targetAnchor, target: inputs.sourceAnchor },
    waypoints: responseWaypointsFor(waypoints, lane),
    lane,
    replyStep: responseLaneFor(lane) - lane,
    obstacles,
    spine: responseSpineFor(spine),
    mode,
    fallback,
    avoid: routing === 'smoothstep' ? stepPolyline(request.d) : undefined,
    spread: inputs.spread ? { source: inputs.spread.target, target: inputs.spread.source } : undefined,
    tracks: inputs.tracks?.response,
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

/** What `rawRouteInputs` may be told instead of reading it from the document: the live rects
 *  and obstacles of a gesture, which only the canvas knows. */
export interface RouteOverrides {
  source?: Rect;
  target?: Rect;
  obstacles?: readonly Rect[];
}

/**
 * A connector's route inputs before its runs are separated from other connectors': read from its
 * document the one way every renderer reads them — its shapes' rects, its lane among parallel
 * siblings, the trunk it shares, the shapes near it, where its automatic ends were spread and whether
 * it may still search. `connectorRoutes.ts` adds the separation; everything that draws, measures or
 * judges a connector goes through there. `obstacleNodes` is what it is routed around — the document's
 * nodes, less any a gesture is moving.
 */
export function rawRouteInputs(
  edge: DraftEdge,
  doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  scope: PlanScope,
  byId?: ReadonlyMap<string, DraftNode>,
  overrides: RouteOverrides = {},
  obstacleNodes: readonly DraftNode[] = doc.nodes,
): EdgeRouteInputs | null {
  const inputs = connectorInputsWithin(edge, doc, scope, byId, overrides, obstacleNodes);
  if (!inputs || searchAllowed(edge.id, doc, scope)) return inputs;
  return { ...inputs, fallback: false };
}

/** `rawRouteInputs` before the diagram's search budget is consulted. */
function connectorInputsWithin(
  edge: DraftEdge,
  doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  scope: PlanScope,
  byId?: ReadonlyMap<string, DraftNode>,
  overrides: RouteOverrides = {},
  obstacleNodes: readonly DraftNode[] = doc.nodes,
): EdgeRouteInputs | null {
  const nodes = byId ?? new Map(doc.nodes.map((node) => [node.id, node]));
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return null;
  return {
    source: overrides.source ?? rectOf(source),
    target: overrides.target ?? rectOf(target),
    routing: edge.routing,
    label: edge.label,
    sourceAnchor: edge.sourceAnchor,
    targetAnchor: edge.targetAnchor,
    hasResponse: edge.hasResponse,
    lane: laneIndex(doc.edges).get(edge.id)?.offset ?? 0,
    spine: routingPlan(doc.nodes, doc.edges, scope).spineFor(edge.id),
    obstacles: overrides.obstacles ?? obstaclesForEdge(obstacleNodes, edge.source, edge.target, scope),
    waypoints: edge.waypoints,
    ...withSpread(endpointPlan(doc.nodes, doc.edges, scope).spreadFor(edge.id)),
  };
}

const withSpread = (spread: EdgeSpread | undefined) => (spread ? { spread } : {});

/** Search work one change to a diagram may spend finding clear lines, in heap pops (`pathfinder.ts`). */
const COMMIT_POPS = 400_000;
/** Up to this many connectors, every line may spend its whole search budget and stay under `COMMIT_POPS`. */
const UNPLANNED_EDGES = Math.floor(COMMIT_POPS / (2 * MAX_POPS));

const NONE_DENIED: ReadonlySet<string> = new Set();
const deniedCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], ReadonlySet<string>>>();
let lastDenied: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[]; denied: ReadonlySet<string> } | null = null;

/**
 * Whether a connector may search for a clear line when its quick one is blocked. A diagram's
 * connectors share one budget (`COMMIT_POPS`): they are routed in id order, and once the search work
 * spent passes it, every later connector draws its quick line and says `budget`. The same diagram
 * always spends it the same way. A diagram small enough that every line could spend its whole own
 * budget needs no plan.
 */
export function searchAllowed(edgeId: string, doc: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }, scope: PlanScope): boolean {
  if (doc.edges.length <= UNPLANNED_EDGES) return true;
  return !deniedOf(doc.nodes, doc.edges, scope).has(edgeId);
}

function deniedOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope): ReadonlySet<string> {
  const known = deniedCache.get(nodes)?.get(edges);
  if (known) return known;
  const previous = lastDenied;
  const denied = previous && previous.edges === edges && sameNodeGeometry(previous.nodes, nodes) ? previous.denied : computeDenied(nodes, edges, scope);
  if (scope === 'canvas') lastDenied = { nodes, edges, denied };
  const byNodes = deniedCache.get(nodes);
  if (byNodes) byNodes.set(edges, denied);
  else deniedCache.set(nodes, new WeakMap([[edges, denied]]));
  return denied;
}

/** A module-level function, so the cached set holds ids and nothing of the routing done to find them. */
function computeDenied(nodes: readonly DraftNode[], edges: readonly DraftEdge[], scope: PlanScope): ReadonlySet<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let spent = 0;
  let denied: Set<string> | null = null;
  for (const edge of ordered) {
    if (denied) {
      denied.add(edge.id);
      continue;
    }
    const inputs = connectorInputsWithin(edge, { nodes, edges }, scope, byId);
    if (!inputs) continue;
    const routes = edgeRoutes(inputs, scope);
    spent += routes.request.work + (routes.response?.work ?? 0);
    if (spent >= COMMIT_POPS) denied = new Set();
  }
  return denied ?? NONE_DENIED;
}
