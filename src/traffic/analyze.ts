import { baseCategory, categoryOf } from '../document/connectorSemantics';
import type { DraftEdge } from '../document/types';
import { stronglyConnected as componentsOf, type Component } from '../model/scc';
import { isBaselineClass } from './classify';
import { trafficGroupOf } from './eligibility';
import { buildTrafficGraph, compareText, type GraphResult } from './graph';
import {
  DEFAULT_TRAFFIC_LIMITS,
  MAX_LISTED,
  PATH_CAP,
  type TrafficAnalysis,
  type TrafficInput,
  type TrafficInteraction,
  type TrafficLimits,
  type TrafficNode,
  type WorkloadKind,
} from './types';

/**
 * Modeled paths over the traffic graph (`graph.ts`): each entry point starts one, and every
 * baseline interaction carries its source's paths on to its target — certainly, or only possibly
 * when the interaction's share is unknown. See `types.ts` for what a path is, and isn't.
 *
 * Loops are counted once. A strongly connected component is treated as one place on the way: every
 * path entering it can reach each member at least once, and the interactions inside it carry
 * nothing more, because how many times a loop repeats is exactly what a diagram doesn't say.
 */

export type { Component };

const WORKLOAD_ORDER: WorkloadKind[] = ['request', 'message', 'data'];

function cap(value: number): number {
  return Math.min(PATH_CAP, Math.max(0, value));
}

function workloadOf(interaction: TrafficInteraction): WorkloadKind | undefined {
  if (interaction.class === 'request') return 'request';
  if (interaction.class === 'publish' || interaction.class === 'deliver') return 'message';
  if (interaction.class === 'data') return 'data';
  return undefined;
}

/** Loops among baseline interactions, components sources first (`model/scc.ts`). The outage walk
 *  (`outage.ts`) reads its loops with it too. */
export function stronglyConnected(ids: readonly string[], outgoing: ReadonlyMap<string, readonly TrafficInteraction[]>): { components: Component[]; componentOf: Map<string, number> } {
  const adjacency = new Map<string, string[]>();
  for (const id of ids) {
    adjacency.set(id, [...new Set((outgoing.get(id) ?? []).map((interaction) => interaction.to))].sort(compareText));
  }
  return componentsOf(ids, adjacency);
}

function nodeResult(id: string, graph: GraphResult): TrafficNode {
  const node = graph.nodes.get(id)!;
  const group = trafficGroupOf(node);
  return {
    id,
    role: graph.roles.get(id)!,
    ...(group ? { group } : {}),
    paths: { definite: 0, possible: 0 },
    sources: [],
    targets: [],
    entries: [],
    entryCount: 0,
    workloads: [],
    isEntry: false,
    inLoop: false,
  };
}

/** A work queue hands each message to one of its consumers; a topic or stream gives every one of
 *  them every message. Only the first is a split whose share the diagram doesn't hold. A gateway
 *  is the request-side counterpart of a work queue: it routes each request to one of the services
 *  behind it, so its routes are a split too. */
function applyMessagingCertainty(graph: GraphResult, outgoing: Map<string, TrafficInteraction[]>): void {
  const drawn = new Map(graph.edgeList.map((edge) => [edge.id, edge]));
  for (const [sourceId, list] of outgoing) {
    if (baseCategory(categoryOf(graph.nodes.get(sourceId)!)) === 'gateway') {
      const routed = list.filter((interaction) => interaction.class === 'request' && interaction.edgeIds.some((id) => routesFrom(drawn.get(id), sourceId)));
      if (new Set(routed.map((interaction) => interaction.to)).size >= 2) {
        for (const interaction of routed) {
          if (interaction.certainty === 'possible') continue;
          interaction.certainty = 'possible';
          interaction.uncertainty = 'routed';
        }
      }
      continue;
    }
    if (graph.roles.get(sourceId) !== 'messaging') continue;
    const deliveries = list.filter((interaction) => interaction.class === 'deliver');
    if (new Set(deliveries.map((interaction) => interaction.to)).size < 2) continue;
    const category = categoryOf(graph.nodes.get(sourceId)!);
    if (category === 'topic' || category === 'stream') continue;
    for (const interaction of deliveries) {
      interaction.certainty = 'possible';
      interaction.uncertainty = 'competing-consumers';
    }
  }
}

/** A connector out of a gateway that routes — said so, or left to the gateway's own default. */
function routesFrom(edge: DraftEdge | undefined, gatewayId: string): boolean {
  return edge !== undefined && edge.source === gatewayId && (edge.semantic === 'routes' || edge.semantic === undefined);
}

/**
 * The connectors every route of one Junction split shares — from the source up to where the routes
 * part — keyed `${from}|${edgeId}`. A source's split routes are grouped by the leg they leave on.
 */
function sharedBeforeSplit(interactions: TrafficInteraction[]): Set<string> {
  const groups = new Map<string, TrafficInteraction[]>();
  for (const interaction of interactions) {
    if (interaction.uncertainty !== 'junction-split' || interaction.edgeIds.length === 0) continue;
    const key = `${interaction.from}|${interaction.edgeIds[0]}`;
    const group = groups.get(key);
    if (group) group.push(interaction);
    else groups.set(key, [interaction]);
  }
  const shared = new Set<string>();
  for (const group of groups.values()) {
    const [first, ...rest] = group;
    // Its sibling routes merged into a definite interaction elsewhere: only the leg it left on is
    // certainly shared.
    if (rest.length === 0) {
      shared.add(`${first!.from}|${first!.edgeIds[0]}`);
      continue;
    }
    for (const edgeId of first!.edgeIds) {
      if (rest.every((interaction) => interaction.edgeIds.includes(edgeId))) shared.add(`${first!.from}|${edgeId}`);
    }
  }
  return shared;
}

/**
 * What each drawn connector carries. A connector shared by several interactions — a leg of a
 * Junction fan-in — carries the paths of every *source* that crosses it, summed; one source's
 * several routes over the same leg (a split after it) are the same traffic, so they count once.
 * The leg before a split certainly carries its source's traffic, even though where it goes next
 * is only possible.
 */
function readEdges(graph: GraphResult, interactions: TrafficInteraction[], nodes: Map<string, TrafficNode>): void {
  const perSource = new Map<string, Map<string, { definite: number; possible: number; flow: boolean }>>();
  const beforeSplit = sharedBeforeSplit(interactions);
  for (const interaction of interactions) {
    const baseline = isBaselineClass(interaction.class);
    for (const edgeId of interaction.edgeIds) {
      const reading = graph.edges.get(edgeId);
      if (!reading) continue;
      if (!baseline) {
        // Not traffic, but say what it is rather than "not established".
        if (reading.participation === 'none' && reading.class === 'unknown') reading.class = interaction.class;
        continue;
      }
      reading.class = reading.participation === 'none' ? interaction.class : reading.class;
      if (interaction.loop) {
        // Traffic, counted once: lit, but carrying nothing beyond what entered the loop.
        if (reading.participation === 'none') reading.participation = 'uncertain';
        continue;
      }
      const source = nodes.get(interaction.from);
      const definite = interaction.certainty === 'definite' || beforeSplit.has(`${interaction.from}|${edgeId}`);
      const bySource = perSource.get(edgeId) ?? new Map();
      const previous = bySource.get(interaction.from) ?? { definite: 0, possible: 0, flow: false };
      bySource.set(interaction.from, {
        definite: Math.max(previous.definite, definite ? (source?.paths.definite ?? 0) : 0),
        possible: Math.max(previous.possible, source?.paths.possible ?? 0),
        flow: previous.flow || definite,
      });
      perSource.set(edgeId, bySource);
      reading.participation = reading.participation === 'flow' || definite ? 'flow' : 'uncertain';
    }
  }
  for (const [edgeId, bySource] of perSource) {
    const reading = graph.edges.get(edgeId)!;
    let definite = 0;
    let possible = 0;
    for (const value of bySource.values()) {
      definite = cap(definite + value.definite);
      possible = cap(possible + value.possible);
    }
    reading.paths = { definite, possible: Math.max(possible, definite) };
  }
}

export function analyzeTraffic(input: TrafficInput, limits: TrafficLimits = DEFAULT_TRAFFIC_LIMITS): TrafficAnalysis {
  const graph = buildTrafficGraph(input, limits);
  const incoming = new Map<string, TrafficInteraction[]>();
  const outgoing = new Map<string, TrafficInteraction[]>();
  for (const interaction of graph.interactions) {
    if (!isBaselineClass(interaction.class)) continue;
    (incoming.get(interaction.to) ?? incoming.set(interaction.to, []).get(interaction.to)!).push(interaction);
    (outgoing.get(interaction.from) ?? outgoing.set(interaction.from, []).get(interaction.from)!).push(interaction);
  }
  applyMessagingCertainty(graph, outgoing);

  const runtimeIds = [...graph.roles].filter(([, role]) => role !== 'excluded').map(([id]) => id).sort(compareText);
  const nodes = new Map<string, TrafficNode>();
  for (const id of runtimeIds) nodes.set(id, nodeResult(id, graph));

  // A failure destination is not an independent source of normal work. In particular, a DLQ
  // holding messages starts no baseline traffic until a person explicitly explores a replay.
  const recoveryDestinations = new Set(graph.interactions.filter((item) => item.class === 'failure').map((item) => item.to));
  const hasRecovery = [...graph.nodes.values()].some((node) => node.deliveryRole === 'dead-letter')
    || graph.edgeList.some((edge) => edge.semantic === 'compensates');
  const entries = new Set(
    runtimeIds.filter((id) => {
      const role = graph.roles.get(id);
      return (role === 'origin' || role === 'compute' || role === 'messaging') && outgoing.has(id) && !incoming.has(id)
        && !recoveryDestinations.has(id) && graph.nodes.get(id)?.deliveryRole !== 'dead-letter';
    }),
  );

  for (const interaction of graph.interactions) {
    if (!isBaselineClass(interaction.class)) continue;
    const from = nodes.get(interaction.from);
    const to = nodes.get(interaction.to);
    if (!from || !to) continue;
    if (!from.targets.includes(to.id)) from.targets.push(to.id);
    if (!to.sources.includes(from.id)) to.sources.push(from.id);
    const workload = workloadOf(interaction);
    if (workload && !to.workloads.includes(workload)) to.workloads.push(workload);
  }
  for (const node of nodes.values()) {
    node.sources.sort(compareText);
    node.targets.sort(compareText);
    node.workloads.sort((a, b) => WORKLOAD_ORDER.indexOf(a) - WORKLOAD_ORDER.indexOf(b));
  }

  const { components, componentOf } = stronglyConnected(runtimeIds, outgoing);
  for (const interaction of graph.interactions) {
    if (!isBaselineClass(interaction.class)) continue;
    const at = componentOf.get(interaction.from);
    interaction.loop = at !== undefined && at === componentOf.get(interaction.to) && components[at]!.loop;
  }

  // Sources first, so every path a component receives is final before it is passed on.
  const reaching: Set<string>[] = components.map(() => new Set());
  components.forEach((component, position) => {
    const members = component.members;
    const definiteAt = new Map<string, number>(members.map((id) => [id, 0]));
    let possibleIn = 0;
    const own = reaching[position]!;
    for (const id of members) {
      if (entries.has(id)) {
        definiteAt.set(id, 1);
        possibleIn = cap(possibleIn + 1);
        own.add(id);
        nodes.get(id)!.isEntry = true;
      }
      for (const interaction of incoming.get(id) ?? []) {
        if (interaction.loop) continue;
        const from = nodes.get(interaction.from);
        const fromComponent = componentOf.get(interaction.from);
        if (!from || fromComponent === undefined || fromComponent === position) continue;
        possibleIn = cap(possibleIn + from.paths.possible);
        if (interaction.certainty === 'definite') definiteAt.set(id, cap(definiteAt.get(id)! + from.paths.definite));
        for (const entry of reaching[fromComponent]!) own.add(entry);
      }
    }
    for (const id of members) {
      const node = nodes.get(id)!;
      if (component.loop) {
        node.inLoop = true;
        node.paths = { definite: definiteAt.get(id)!, possible: possibleIn };
      } else {
        // A lone member's possible paths are just its own incoming ones (or its entry's one).
        node.paths = { definite: definiteAt.get(id)!, possible: Math.max(possibleIn, definiteAt.get(id)!) };
      }
      node.entries = [...own].sort(compareText).slice(0, MAX_LISTED);
      node.entryCount = own.size;
    }
  });

  for (const interaction of graph.interactions) {
    const from = nodes.get(interaction.from);
    interaction.paths =
      !isBaselineClass(interaction.class) || interaction.loop || !from
        ? { definite: 0, possible: 0 }
        : { definite: interaction.certainty === 'definite' ? from.paths.definite : 0, possible: from.paths.possible };
  }

  readEdges(graph, graph.interactions, nodes);

  const anyBaseline = graph.interactions.some((interaction) => isBaselineClass(interaction.class));
  const status = entries.size > 0 ? 'ok' : hasRecovery ? 'recovery-only' : !anyBaseline ? 'nothing-to-analyze' : 'no-entry';

  // Excluded shapes appear only where a path stopped at one, so the canvas can say why.
  for (const diagnostic of graph.diagnostics) {
    if (diagnostic.kind !== 'unsupported-hop') continue;
    const id = diagnostic.nodeIds[0]!;
    if (!nodes.has(id)) nodes.set(id, nodeResult(id, graph));
  }

  const analysis: TrafficAnalysis = {
    status,
    nodes,
    interactions: graph.interactions,
    edges: graph.edges,
    entries: [...entries].sort(compareText),
    truncated: graph.truncated,
  };
  return analysis;
}
