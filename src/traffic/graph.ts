import { categoryOf } from '../document/connectorSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { trafficRoleOf } from './eligibility';
import { behaviourClass, classifyConnector, isBaselineClass, type ClassifiedTraffic } from './classify';
import type { PathCount, TrafficClass, TrafficInput, TrafficInteraction, TrafficLimits, TrafficRole, UncertaintyReason } from './types';

/**
 * The traffic graph: every drawn connector read as zero or one logical interaction between two
 * concrete nodes, with Junctions seen through.
 *
 * A Junction is topology, not a resource. A connector into one is followed through any chain of
 * Junctions to every concrete node it reaches, and each reached node becomes one interaction from
 * where the connector started — never one per Junction crossed, and never one per parallel line:
 * interactions are keyed by their two ends and class, so a pair drawn twice, or reached by two routes
 * through different Junctions, is still one interaction. What a Junction does *not* say is how
 * traffic divides when it fans out, so a split keeps every branch only `possible`.
 */

export interface TrafficDiagnostic {
  kind: 'ambiguous-split' | 'conflicting-semantics' | 'dangling-junction' | 'unsupported-hop' | 'undirected';
  nodeIds: string[];
  edgeIds: string[];
}

export interface EdgeReading {
  class: TrafficClass;
  participation: 'flow' | 'uncertain' | 'none';
  paths: PathCount;
}

export interface GraphResult {
  nodes: Map<string, DraftNode>;
  roles: Map<string, TrafficRole>;
  /** The connectors in scope, first of each id, in document order. */
  edgeList: DraftEdge[];
  edges: Map<string, EdgeReading>;
  interactions: TrafficInteraction[];
  diagnostics: TrafficDiagnostic[];
  truncated: boolean;
}

interface Route {
  source: DraftNode;
  target: DraftNode;
  edges: DraftEdge[];
  junctionIds: string[];
}

type Classified = ClassifiedTraffic & { conflict: boolean };

const CLASS_ORDER: TrafficClass[] = [
  'request',
  'data',
  'publish',
  'deliver',
  'background',
  'failure',
  'retry',
  'callback',
  'structural',
  'participant',
  'association',
  'unknown',
];

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareInteraction(a: TrafficInteraction, b: TrafficInteraction): number {
  return compareText(a.from, b.from) || compareText(a.to, b.to) || CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class);
}

function mergeIds(existing: string[], next: readonly string[]): void {
  for (const id of next) if (!existing.includes(id)) existing.push(id);
}

/** The behaviour of a route is the most consequential one any of its segments has. */
const BEHAVIOUR_ORDER: TrafficClass[] = ['retry', 'failure', 'callback'];

/**
 * What a route through Junctions carries. Every segment is read with the route's two concrete ends,
 * so "reads" on the last leg of Database → J → Service still means the service reads the database.
 * Segments with a semantic vote, and must agree; with no vote at all, the pairing's own default
 * stands (marked inferred). The work direction comes from the vote that decided the class.
 */
function routeClass(route: Route): Classified {
  const classifications = route.edges.map((edge) => classifyConnector(edge, route.source, route.target));
  const votes = classifications.filter((_, index) => route.edges[index]!.semantic !== undefined);
  const deciding = votes[0] ?? classifications[0]!;
  const conflict = new Set(votes.map((value) => value.class)).size > 1;
  let trafficClass: TrafficClass = conflict ? 'unknown' : deciding.class;
  if (!conflict && isBaselineClass(trafficClass)) {
    const behaviours = route.edges.map((edge) => behaviourClass(edge.kind));
    trafficClass = BEHAVIOUR_ORDER.find((value) => behaviours.includes(value)) ?? trafficClass;
  }
  if (route.edges.some((edge) => !edge.directed)) trafficClass = 'association';

  const conditional = route.edges.some((edge) => edge.kind === 'conditional' || Boolean(edge.condition?.trim()));
  const uncertain = classifications.find((value) => value.certainty === 'possible');
  const uncertainty: UncertaintyReason | undefined = conditional ? 'conditional' : uncertain?.uncertainty;
  return {
    from: deciding.from,
    to: deciding.to,
    class: trafficClass,
    workload: isBaselineClass(trafficClass) ? deciding.workload : undefined,
    certainty: conditional || uncertain ? 'possible' : 'definite',
    ...(uncertainty ? { uncertainty } : {}),
    // A call is synchronous end to end or not at all: one asynchronous hop and nobody is waiting.
    sync: (trafficClass === 'request' || trafficClass === 'data') && route.edges.every((edge) => edge.async !== true && (edge.kind === undefined || edge.kind === 'sync')),
    inferred: votes.length === 0 && classifications.every((value) => value.inferred),
    conflict,
  };
}

function firstNodes(nodes: readonly DraftNode[]): Map<string, DraftNode> {
  const result = new Map<string, DraftNode>();
  for (const node of nodes) if (!result.has(node.id)) result.set(node.id, node);
  return result;
}

function selectedEdges(input: TrafficInput): DraftEdge[] {
  const seen = new Set<string>();
  const result: DraftEdge[] = [];
  for (const edge of input.edges) {
    if (seen.has(edge.id) || (input.edgeIds !== undefined && !input.edgeIds.has(edge.id))) continue;
    seen.add(edge.id);
    result.push(edge);
  }
  return result;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** One step of a Junction walk: the Junction reached and the connector that reached it. */
interface WalkStep {
  junctionId: string;
  via: DraftEdge | null;
  parent: number;
}

export function buildTrafficGraph(input: TrafficInput, limits: TrafficLimits): GraphResult {
  const nodes = firstNodes(input.nodes);
  const roles = new Map<string, TrafficRole>();
  for (const [id, node] of nodes) roles.set(id, trafficRoleOf(node));
  const roleOf = (id: string): TrafficRole | undefined => roles.get(id);
  const isConcrete = (role: TrafficRole | undefined) => role !== undefined && role !== 'junction' && role !== 'excluded';

  const edgeList = selectedEdges(input);
  const outgoing = new Map<string, DraftEdge[]>();
  const incoming = new Map<string, DraftEdge[]>();
  const edges = new Map<string, EdgeReading>();
  for (const edge of edgeList) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (source && target && edge.directed) {
      push(outgoing, edge.source, edge);
      push(incoming, edge.target, edge);
    }
    // Junction legs are read once their whole route is known; until then they carry nothing.
    const direct = source && target && isConcrete(roleOf(source.id)) && isConcrete(roleOf(target.id));
    edges.set(edge.id, {
      class: direct ? classifyConnector(edge, source, target).class : 'unknown',
      participation: 'none',
      paths: { definite: 0, possible: 0 },
    });
  }

  const interactionsById = new Map<string, TrafficInteraction>();
  const diagnostics: TrafficDiagnostic[] = [];
  let truncated = false;
  let junctionSteps = 0;
  const budget = Math.max(0, limits.maxJunctionSteps);
  const spend = (amount = 1): boolean => {
    if (junctionSteps + amount > budget) {
      truncated = true;
      return false;
    }
    junctionSteps += amount;
    return true;
  };

  const addInteraction = (classified: Classified, edgeIds: string[], junctionIds: string[], drawnSource: string): void => {
    let { from, to } = classified;
    // An undirected line has no work direction; its two ends are stored in a stable order.
    if (classified.class === 'association' && compareText(to, from) < 0) [from, to] = [to, from];
    const id = `${from}>${to}>${classified.class}`;
    const reverse = classified.from !== drawnSource;
    const existing = interactionsById.get(id);
    if (existing) {
      for (const edgeId of edgeIds) {
        if (existing.edgeIds.includes(edgeId)) continue;
        existing.edgeIds.push(edgeId);
        if (reverse) existing.reverseEdgeIds.push(edgeId);
      }
      mergeIds(existing.junctionIds, junctionIds);
      if (classified.certainty === 'definite') {
        existing.certainty = 'definite';
        delete existing.uncertainty;
      } else if (existing.certainty !== 'definite' && existing.uncertainty === undefined && classified.uncertainty) {
        existing.uncertainty = classified.uncertainty;
      }
      existing.inferred = existing.inferred && classified.inferred;
      // Drawn both ways (one solid, one dashed), nobody can say a caller waits.
      existing.sync = existing.sync && classified.sync;
      return;
    }
    if (interactionsById.size >= Math.max(0, limits.maxInteractions)) {
      truncated = true;
      return;
    }
    interactionsById.set(id, {
      id,
      from,
      to,
      class: classified.class,
      ...(classified.workload ? { workload: classified.workload } : {}),
      edgeIds: [...edgeIds],
      reverseEdgeIds: reverse ? [...edgeIds] : [],
      junctionIds: [...junctionIds],
      certainty: classified.certainty,
      ...(classified.uncertainty ? { uncertainty: classified.uncertainty } : {}),
      sync: classified.sync,
      inferred: classified.inferred,
      loop: false,
      paths: { definite: 0, possible: 0 },
    });
  };

  // Direct connectors between two concrete nodes.
  for (const edge of edgeList) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target || !isConcrete(roleOf(source.id)) || !isConcrete(roleOf(target.id))) continue;
    addInteraction({ ...classifyConnector(edge, source, target), conflict: false }, [edge.id], [], source.id);
    if (!edge.directed) diagnostics.push({ kind: 'undirected', nodeIds: [source.id, target.id].sort(compareText), edgeIds: [edge.id] });
  }

  /**
   * Every concrete node one connector into a Junction reaches. Breadth first, neighbours in document
   * order, and each Junction entered once per walk — the first route found to a Junction is the one
   * its segments are read from, so a Junction cycle ends the walk instead of extending it.
   */
  const walkFrom = (leg: DraftEdge, source: DraftNode): void => {
    if (!spend()) return;
    const steps: WalkStep[] = [{ junctionId: leg.target, via: null, parent: -1 }];
    const entered = new Set([leg.target]);
    const reached: { target: DraftNode; last: DraftEdge; step: number }[] = [];
    for (let head = 0; head < steps.length && !truncated; head += 1) {
      for (const edge of outgoing.get(steps[head]!.junctionId) ?? []) {
        if (!spend()) break;
        const target = nodes.get(edge.target);
        if (!target) continue;
        const role = roleOf(target.id);
        if (role === 'junction') {
          if (entered.has(target.id)) continue;
          entered.add(target.id);
          steps.push({ junctionId: target.id, via: edge, parent: head });
        } else if (role !== 'excluded') {
          reached.push({ target, last: edge, step: head });
        }
      }
    }
    if (reached.length === 0) {
      diagnostics.push({ kind: 'dangling-junction', nodeIds: [source.id, leg.target], edgeIds: [leg.id] });
      return;
    }

    const routes: { route: Route; classified: Classified }[] = [];
    for (const { target, last, step } of reached) {
      const chain: DraftEdge[] = [];
      const junctionIds: string[] = [];
      for (let at = step; at >= 0; at = steps[at]!.parent) {
        junctionIds.push(steps[at]!.junctionId);
        const via = steps[at]!.via;
        if (via) chain.push(via);
      }
      if (!spend(chain.length)) break;
      chain.reverse();
      junctionIds.reverse();
      const route: Route = { source, target, edges: [leg, ...chain, last], junctionIds };
      routes.push({ route, classified: routeClass(route) });
    }

    // A split is where *traffic* divides: a structural or failure branch beside a call is not a
    // second destination for the call's traffic, and a route whose work runs back toward the source
    // (Database → J → Services, "read by") is several readers meeting at one store, not a split.
    const divides = ({ classified }: { classified: Classified }) => isBaselineClass(classified.class) && classified.from === source.id;
    const baselineTargets = new Set(routes.filter(divides).map(({ route }) => route.target.id));
    const fansOutToAll = categoryOf(source) === 'topic' || categoryOf(source) === 'stream';
    const splits = baselineTargets.size > 1 && !fansOutToAll;
    if (splits) {
      diagnostics.push({
        kind: 'ambiguous-split',
        nodeIds: [source.id, leg.target, ...[...baselineTargets]],
        edgeIds: routes.filter(divides).flatMap(({ route }) => route.edges.map((edge) => edge.id)),
      });
    }
    for (const { route, classified } of routes) {
      if (classified.conflict) {
        diagnostics.push({
          kind: 'conflicting-semantics',
          nodeIds: [route.junctionIds[0]!, source.id, route.target.id],
          edgeIds: route.edges.map((edge) => edge.id),
        });
      }
      const split = splits && divides({ classified });
      addInteraction(
        split ? { ...classified, certainty: 'possible', uncertainty: 'junction-split' } : classified,
        route.edges.map((edge) => edge.id),
        route.junctionIds,
        route.source.id,
      );
    }
  };

  for (const leg of edgeList) {
    const source = nodes.get(leg.source);
    if (!leg.directed || !source || !isConcrete(roleOf(source.id)) || roleOf(leg.target) !== 'junction') continue;
    walkFrom(leg, source);
    if (truncated) break;
  }

  // A Junction nothing feeds, though it leads on to runtime nodes, starts no traffic of its own.
  for (const [junctionId, role] of roles) {
    if (role !== 'junction' || incoming.has(junctionId) || !outgoing.has(junctionId)) continue;
    const pending = [junctionId];
    const visited = new Set<string>();
    let exits = false;
    for (let head = 0; head < pending.length && !exits; head += 1) {
      if (!spend()) break;
      const current = pending[head]!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of outgoing.get(current) ?? []) {
        const targetRole = roleOf(edge.target);
        if (targetRole === 'junction') pending.push(edge.target);
        else if (isConcrete(targetRole)) {
          exits = true;
          break;
        }
      }
    }
    if (exits) diagnostics.push({ kind: 'dangling-junction', nodeIds: [junctionId], edgeIds: (outgoing.get(junctionId) ?? []).map((edge) => edge.id) });
  }

  // Runtime → things that aren't runtime resources → runtime: the diagram stops saying what
  // happens in the middle, so nothing is inferred across it — but the first shape it stopped at is
  // named, however many more follow (Service → Component → Adapter → Database).
  for (const [excludedId, role] of roles) {
    if (role !== 'excluded') continue;
    const before = (incoming.get(excludedId) ?? []).find((edge) => isConcrete(roleOf(edge.source)));
    if (!before) continue;
    const seen = new Set([excludedId]);
    const pending = [excludedId];
    let after: DraftEdge | undefined;
    for (let head = 0; head < pending.length && !after; head += 1) {
      if (!spend()) break;
      for (const edge of outgoing.get(pending[head]!) ?? []) {
        const targetRole = roleOf(edge.target);
        if (isConcrete(targetRole) && edge.target !== before.source) {
          after = edge;
          break;
        }
        if ((targetRole === 'excluded' || targetRole === 'junction') && !seen.has(edge.target)) {
          seen.add(edge.target);
          pending.push(edge.target);
        }
      }
    }
    if (after) diagnostics.push({ kind: 'unsupported-hop', nodeIds: [excludedId, before.source, after.target], edgeIds: [before.id, after.id] });
  }

  const interactions = [...interactionsById.values()].sort(compareInteraction);
  return { nodes, roles, edgeList, edges, interactions, diagnostics, truncated };
}
