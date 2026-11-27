import { linkedCompensations } from '../document/compensation';
import { categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftEdge, DraftFlow, DraftNode, EdgeSemantic } from '../document/types';
import { trafficRoleOf } from './eligibility';
import { outageFact, sourceOf, type OutageFact, type OutageSource } from './technology';
import type { TrafficAnalysis, TrafficInteraction } from './types';

/**
 * Take one thing down and read what follows — from the drawing alone.
 *
 * No rates, no likelihoods: only what the shapes and connectors already say. A caller that waits on
 * the shape fails with it; a queue in front of it holds; a queue in front of something *failing*
 * redelivers and, where one is drawn, dead-letters; a store nothing writes to any more goes stale;
 * whatever only it fed goes quiet. What a shape is decides how it reads: a Service drawn with
 * several instances loses one before it loses all, a cache is fallen through rather than waited on,
 * a topic keeps events or doesn't according to the product it is drawn as, and a Boundary taken
 * down takes everything inside it. A connector can be taken down in a shape's place: both of its
 * ends stay up, and the same rules are applied to that one route.
 *
 * A flow is the drawing's own account of one journey through it, so the outage is read against each:
 * the first step that can no longer happen as drawn, or that it carries on.
 *
 * A failure also catches work half-done. A shape that fails on one step may already have written,
 * published or commanded on another, and a queue that redelivers runs that work again. Which came
 * first is drawn only where a flow orders the two connectors; without one the reading says "if",
 * never "has". A recovery action drawn for the earlier step is the drawn answer.
 *
 * Where the drawing stops short of an answer (no fallback, no dead-letter route, no replay, a
 * single instance) the result is a question for the person — with the edit that would answer it
 * when one exists — never a guess.
 *
 * Imports `document/` only: no React, store, canvas or DOM.
 */

/**
 * `down`: taken down. `failing`: waits on something down or failing, with no fallback drawn.
 * `degraded`: affected, but not wholly — a fallback is drawn, only one of its routes or instances
 * is hit, or the drawing doesn't say. `holding`: messaging whose consumer is down; messages wait.
 * `retrying`: messaging whose consumer is failing; deliveries come back. `catching`: where a drawn
 * fallback or dead-letter route now leads. `stale`: a store still read but no longer written.
 * `quiet`: nothing reaches it any more. `unaffected`: carries on as before.
 */
export type OutageState = 'down' | 'failing' | 'degraded' | 'holding' | 'retrying' | 'catching' | 'stale' | 'quiet' | 'unaffected';

/** `failing`: a call or delivery that now fails. `stopped`: nothing travels it. `recovery`: a
 *  fallback or dead-letter route the outage brings into use. */
export type OutageEdgeState = 'failing' | 'stopped' | 'recovery';

/** An edit that would answer a question — applied by the editor as one ordinary, undoable step. */
export type OutageFix =
  | { kind: 'dead-letter'; queue: string }
  | { kind: 'replay'; from: string; to: string }
  | { kind: 'instances'; node: string };

export interface OutageNote {
  /** Stable for the same outage: `${kind}:${subject ids}`. */
  id: string;
  /** `effect`: what happens. `shield`: what stops it spreading. `question`: what the drawing leaves open. */
  tone: 'effect' | 'shield' | 'question';
  /** A few words to write beside `focus`. */
  note: string;
  /** One or two plain sentences, in the diagram's own names. */
  text: string;
  focus: string[];
  /** For a question: how it would read as an open point on `focus[0]`. */
  ask?: string;
  fix?: OutageFix;
  /** Where a product's documented behaviour quoted in `text` was read from. */
  sources?: OutageSource[];
}

/**
 * What the outage does to one flow drawn over this graph. `breaks`: a step runs over a connector
 * that carries nothing, touches something down, or fails on this journey — a call into a shape
 * that is only failing breaks the flow when the flow says nothing further about that shape, or
 * when one of the steps it shows from there breaks too. `recovery`: no step breaks, and one runs
 * over a fallback or dead-letter route the outage brings into use. `unaffected`: it carries on.
 *
 * A step is counted in the flow's own order, which is the only order the drawing gives. Nothing
 * here says a later step depends on an earlier one — only which steps cannot happen as drawn.
 */
export interface OutageFlow {
  id: string;
  title: string;
  state: 'breaks' | 'recovery' | 'unaffected';
  /** The first step that cannot happen as drawn, counted from 1. Only when it breaks. */
  step?: number;
  /** How many steps the flow has. */
  of: number;
  /** A few words: "breaks at step 3 of 5". */
  note: string;
  /** One plain sentence, in the diagram's own names. */
  text: string;
}

/** What is taken down: a shape, or a Boundary and everything in it. `whole` takes every instance of
 *  a Service drawn with several; without it, one of them. With `connector`, `id` names a connector
 *  instead: both of its ends stay up, and nothing travels between them. */
export interface OutageTarget {
  id: string;
  whole?: boolean;
  connector?: boolean;
}

export interface Outage {
  target: string;
  /** Set when the target is a connector: the shapes that can no longer reach each other across it.
   *  One at each end, unless it is a trunk several routes share on the way into or out of a junction. */
  connector?: { from: string[]; to: string[] };
  /** The runtime shapes that are down: the target, or what its Boundary holds. None for a connector. */
  lost: string[];
  /** Set when only one of a Service's instances is down. */
  instances?: { down: number; of: number };
  headline: string;
  /** Every runtime shape that takes part, with what the outage does to it. */
  nodes: Map<string, OutageState>;
  /** Connectors the outage changes; absent means it carries on as drawn. */
  edges: Map<string, OutageEdgeState>;
  /** In the order the consequence travels: failures, then what absorbs them, then what goes quiet. */
  notes: OutageNote[];
  /** Every flow of this graph that runs over a connector, in the order they are listed. */
  flows: OutageFlow[];
}

/** Whoever makes this interaction holds its request open until it returns. */
export function waitsOn(interaction: TrafficInteraction): boolean {
  if (interaction.loop) return false;
  return (interaction.class === 'request' || interaction.class === 'data') && interaction.sync;
}

function runs(node: DraftNode): boolean {
  const role = trafficRoleOf(node);
  return role === 'compute' || role === 'messaging' || role === 'data';
}

/** The runtime shapes a target stands for: itself, or everything that runs inside its Boundary.
 *  `Graph.lostBy` gives the same answer from an index, for the many targets of a review. */
export function lostBy(nodes: readonly DraftNode[], id: string): string[] {
  const target = nodes.find((node) => node.id === id);
  if (!target) return [];
  if (target.type !== 'group') return runs(target) ? [id] : [];
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  return nodes
    .filter((node) => {
      if (!runs(node)) return false;
      // Bounded by the node count, so a malformed parent loop ends.
      for (let at = node.parentId, steps = 0; at && steps <= nodes.length; at = parents.get(at), steps += 1) if (at === id) return true;
      return false;
    })
    .map((node) => node.id);
}

/** Whether a shape is the kind of thing an outage can be read from, before any analysis. */
export function mayTakeDown(nodes: readonly DraftNode[], id: string): boolean {
  return lostBy(nodes, id).length > 0;
}

/** Whether taking this down says anything: something that runs and takes part in the drawing. */
export function canTakeDown(analysis: TrafficAnalysis, nodes: readonly DraftNode[], id: string): boolean {
  return lostBy(nodes, id).some((lost) => analysis.nodes.has(lost));
}

/** A shape as an outage names it. An unnamed dead-letter queue would otherwise read as its kind's
 *  default, "Queue". */
export function outageNameOf(node: DraftNode | undefined): string {
  if (!node) return 'Untitled';
  if (node.deliveryRole === 'dead-letter' && !node.text?.trim()) return 'the dead-letter queue';
  return displayNameFor(node) || 'Untitled';
}

/** A note's `sources`, when it quotes that sentence of a product fact: spread into the note. */
function cited(fact: OutageFact | null | undefined, sentence: 'holding' | 'down'): { sources?: OutageSource[] } {
  const sources = sourceOf(fact, sentence);
  return sources ? { sources } : {};
}

const WRITES = new Set<EdgeSemantic>(['writes', 'readsWrites', 'indexes', 'ingests', 'invalidates']);
const READS = new Set<EdgeSemantic>(['reads', 'readsWrites', 'query', 'searches', 'watches']);
const QUEUES = new Set<NodeCategory>(['queue', 'deadLetter']);

export function outageOf(
  analysis: TrafficAnalysis,
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  target: OutageTarget,
  flows: readonly DraftFlow[] = [],
): Outage | null {
  const graph = graphOf(analysis, nodes, edges);
  return readOutage(graph, flowStepsOf(flows, graph.edgeById), target, null);
}

/** What a review keeps of a reading (`review.ts`): what the outage changes, never what carries on. */
export interface OutageGlance {
  target: string;
  connector?: { from: string[]; to: string[] };
  instances?: { down: number; of: number };
  /** Shapes it changes, other than what is down. */
  affected: number;
  /** People at the start of a chain that fails with it, in the order the reading meets them. */
  reaches: string[];
  /** Flows with a step that can no longer happen as drawn. */
  breaks: { id: string; title: string }[];
  /** Questions the drawing leaves open about it. */
  questions: number;
}

/** A whole reading, kept to what a review reads of it. */
export function glanceOf(outage: Outage, analysis: TrafficAnalysis): OutageGlance {
  let affected = 0;
  const reaches: string[] = [];
  for (const [id, state] of outage.nodes) {
    if (state === 'unaffected' || state === 'down') continue;
    affected += 1;
    if (state === 'failing' && analysis.nodes.get(id)?.role === 'origin') reaches.push(id);
  }
  return {
    target: outage.target,
    ...(outage.connector ? { connector: outage.connector } : {}),
    ...(outage.instances ? { instances: outage.instances } : {}),
    affected,
    reaches,
    breaks: outage.flows.filter((flow) => flow.state === 'breaks').map((flow) => ({ id: flow.id, title: flow.title })),
    questions: outage.notes.filter((note) => note.tone === 'question').length,
  };
}

/**
 * The outage of each shape and connector of one graph, as a review takes them down in turn.
 *
 * Each is `outageOf`'s reading of that one target, kept to what a review reads of it
 * (`glanceOf`). What does not depend on the target (the drawing's indexes, how far work reaches
 * with nothing down) is worked out once here rather than once per reading, and each reading
 * visits only what its own outage changes. A review used to read the whole graph for every shape
 * and connector, so it grew with the square of the diagram.
 */
export function outageReadings(
  analysis: TrafficAnalysis,
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  flows: readonly DraftFlow[] = [],
): { lostBy: (id: string) => string[]; read: (target: OutageTarget) => OutageGlance | null } {
  const graph = graphOf(analysis, nodes, edges);
  const told = flowStepsOf(flows, graph.edgeById);
  const reach = reachOf(graph, told);
  const read = (target: OutageTarget) => {
    if (reach) return readOutage(graph, told, target, reach);
    const outage = readOutage(graph, told, target, null);
    return outage && glanceOf(outage, analysis);
  };
  return { lostBy: graph.lostBy, read };
}

type EdgeStates = Pick<ReadonlyMap<string, OutageEdgeState>, 'get'>;

/** Whether an interaction writes, or reads, by its connectors' semantics. */
function writesOver(item: TrafficInteraction, edgeById: ReadonlyMap<string, DraftEdge>): boolean {
  return item.edgeIds.some((id) => {
    const semantic = edgeById.get(id)?.semantic;
    return !semantic || WRITES.has(semantic);
  });
}

function readsOver(item: TrafficInteraction, edgeById: ReadonlyMap<string, DraftEdge>): boolean {
  return item.edgeIds.some((id) => {
    const semantic = edgeById.get(id)?.semantic;
    return !semantic || READS.has(semantic);
  });
}

/** What every reading of one graph shares: indexes of the drawing, and of how work travels it. */
interface Graph {
  analysis: TrafficAnalysis;
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  drawn: ReadonlyMap<string, DraftNode>;
  edgeById: ReadonlyMap<string, DraftEdge>;
  /** The interactions that carry work, in the analysis's order, and by where they arrive and leave. */
  baseline: readonly TrafficInteraction[];
  into: ReadonlyMap<string, TrafficInteraction[]>;
  outOf: ReadonlyMap<string, TrafficInteraction[]>;
  /** A drawn way out of a failure, by the shape it leaves: a fallback, a dead-letter route. */
  escapes: ReadonlyMap<string, TrafficInteraction[]>;
  /** Retries by caller, and failure routes by where they lead. */
  retriesFrom: (id: string) => readonly TrafficInteraction[];
  failuresInto: (id: string) => readonly TrafficInteraction[];
  /** The interactions a connector is part of, in the analysis's order. */
  carrying: (edgeId: string) => readonly TrafficInteraction[];
  /** Where an interaction comes in the analysis, so a few gathered from an index keep its order. */
  orderOf: (item: TrafficInteraction) => number;
  /** Shapes a route carrying work of its own leaves: a dead-letter queue with a replay drawn. */
  replays: (id: string) => boolean;
  lostBy: (id: string) => string[];
  /** A shape as an outage names it, remembered: a review names the same shapes again and again. */
  name: (id: string) => string;
}

function graphOf(analysis: TrafficAnalysis, nodes: readonly DraftNode[], edges: readonly DraftEdge[]): Graph {
  const drawn = new Map(nodes.map((node) => [node.id, node]));
  const names = new Map<string, string>();
  const baseline = analysis.interactions.filter((item) => item.paths.possible > 0);
  // Compensation undoes finished work; it is not somewhere a failing call can go instead.
  const compensating = new Set(edges.filter((edge) => edge.semantic === 'compensates').map((edge) => edge.id));
  // Indexed the first time they are asked for: one reading of a shape needs none of them.
  let carried: Map<string, TrafficInteraction[]> | null = null;
  let order: Map<TrafficInteraction, number> | null = null;
  let replaying: Set<string> | null = null;
  let retries: Map<string, TrafficInteraction[]> | null = null;
  let failures: Map<string, TrafficInteraction[]> | null = null;
  const index = () => {
    carried = new Map();
    order = new Map();
    for (const [at, item] of analysis.interactions.entries()) {
      order.set(item, at);
      for (const id of item.edgeIds) {
        const list = carried.get(id);
        if (!list) carried.set(id, [item]);
        else if (list[list.length - 1] !== item) list.push(item);
      }
    }
    return { carried, order };
  };
  return {
    analysis,
    nodes,
    edges,
    drawn,
    edgeById: new Map(edges.map((edge) => [edge.id, edge])),
    baseline,
    into: group(baseline, (item) => item.to),
    outOf: group(baseline, (item) => item.from),
    escapes: group(
      analysis.interactions.filter((item) => item.class === 'failure' && !item.edgeIds.some((id) => compensating.has(id))),
      (item) => item.from,
    ),
    retriesFrom: (id) => (retries ??= group(analysis.interactions.filter((item) => item.class === 'retry'), (item) => item.from)).get(id) ?? [],
    failuresInto: (id) => (failures ??= group(analysis.interactions.filter((item) => item.class === 'failure'), (item) => item.to)).get(id) ?? [],
    carrying: (edgeId) => (carried ?? index().carried).get(edgeId) ?? [],
    orderOf: (item) => (order ?? index().order).get(item)!,
    replays: (id) => (replaying ??= new Set(analysis.interactions.filter((item) => !!item.workload).map((item) => item.from))).has(id),
    lostBy: insideOf(nodes, drawn),
    name: (id) => {
      let known = names.get(id);
      if (known === undefined) names.set(id, (known = outageNameOf(drawn.get(id))));
      return known;
    },
  };
}

/**
 * `lostBy`, answered from an index of what runs inside each Boundary, built the first time a
 * Boundary is asked about. The same shapes in the same order: a shape is inside a Boundary when the
 * Boundary is among its ancestors, and a malformed parent loop ends where it repeats.
 */
function insideOf(nodes: readonly DraftNode[], drawn: ReadonlyMap<string, DraftNode>): (id: string) => string[] {
  // `lostBy` finds its target with `find`: the first of two shapes with one id, where `drawn` keeps the last.
  let first: ReadonlyMap<string, DraftNode> = drawn;
  if (drawn.size !== nodes.length) {
    const map = new Map<string, DraftNode>();
    for (const node of nodes) if (!map.has(node.id)) map.set(node.id, node);
    first = map;
  }
  let inside: Map<string, string[]> | null = null;
  const build = () => {
    const index = new Map<string, string[]>();
    const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
    for (const node of nodes) {
      if (!runs(node)) continue;
      const seen = new Set<string>();
      for (let at = node.parentId; at && !seen.has(at); at = parents.get(at)) {
        seen.add(at);
        const list = index.get(at);
        if (list) list.push(node.id);
        else index.set(at, [node.id]);
      }
    }
    return index;
  };
  return (id) => {
    const target = first.get(id);
    if (!target) return [];
    if (target.type !== 'group') return runs(target) ? [id] : [];
    inside ??= build();
    return inside.get(id)?.slice() ?? [];
  };
}

/**
 * How far work travels with nothing down: what each reading of a review starts from, so it need
 * only work out what its own outage changes. Every route that carries work runs from one place to
 * a later one (the analysis counts a loop once and gives the routes inside it nothing to carry), so
 * a shape stays reached while any route still arrives at it from a shape that is.
 */
interface Reach {
  /** Reached from an entry point, with nothing down. */
  reached: ReadonlySet<string>;
  /** How many routes carrying work arrive at each reached shape from reached shapes. */
  arrivals: ReadonlyMap<string, number>;
  /** Shapes that take part but no route walked from an entry point arrives at: quiet in every
   *  reading that says nothing else of them. */
  unreached: ReadonlySet<string>;
  /** Stores step 5 would find stale with nothing down: every writer unreached, a reader not. */
  stale: ReadonlySet<string>;
  entries: ReadonlySet<string>;
  /** Where each route that carries work comes among them: step 5 marks them in this order. */
  routeOrder: ReadonlyMap<TrafficInteraction, number>;
  /** Whether each flow breaks with nothing down (on what the unreached shapes stop), and which
   *  flows a connector or a shape is part of: a reading reads again only the flows it touches. */
  breaks: readonly boolean[];
  flowsOver: ReadonlyMap<string, number[]>;
  flowsAt: ReadonlyMap<string, number[]>;
}

/** `null` if the routes carrying work ever loop back, which the analysis rules out: then every
 *  reading of the review reads the whole graph, as `outageOf` does. */
function reachOf(graph: Graph, flows: readonly FlowSteps[]): Reach | null {
  const { analysis, baseline, outOf, into, edgeById } = graph;
  const reached = new Set<string>();
  const pending = [...analysis.entries];
  for (let head = 0; head < pending.length; head += 1) {
    const at = pending[head]!;
    if (reached.has(at)) continue;
    reached.add(at);
    for (const item of outOf.get(at) ?? []) pending.push(item.to);
  }
  const arrivals = new Map<string, number>();
  for (const item of baseline) if (reached.has(item.from)) arrivals.set(item.to, (arrivals.get(item.to) ?? 0) + 1);
  // Every reached shape is released once all that arrives at it has been: a loop never is.
  const left = new Map(arrivals);
  const ready = [...reached].filter((id) => !left.get(id));
  for (let head = 0; head < ready.length; head += 1) {
    for (const item of outOf.get(ready[head]!) ?? []) {
      const count = left.get(item.to)! - 1;
      left.set(item.to, count);
      if (count === 0) ready.push(item.to);
    }
  }
  if (ready.length !== reached.size) return null;
  const unreached = new Set<string>();
  for (const id of analysis.nodes.keys()) if (takesPartIn(analysis, id) && !reached.has(id)) unreached.add(id);
  const stale = new Set<string>();
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'data' || !takesPartIn(analysis, node.id) || unreached.has(node.id)) continue;
    const arrivals = (into.get(node.id) ?? []).filter((item) => item.class === 'data');
    const writing = arrivals.filter((item) => writesOver(item, edgeById));
    if (
      writing.length > 0 &&
      arrivals.some((item) => readsOver(item, edgeById) && !unreached.has(item.from)) &&
      writing.every((item) => unreached.has(item.from))
    ) stale.add(node.id);
  }
  // With nothing down, step 5 stops what leaves an unreached shape, and nothing else.
  const stopped = new Set<string>();
  for (const id of unreached) for (const item of outOf.get(id) ?? []) for (const edgeId of item.edgeIds) stopped.add(edgeId);
  const still = { get: (id: string) => (stopped.has(id) ? ('stopped' as const) : undefined) };
  const breaks = flows.map((flow) => flowBreaks(flow, still, new Set()));
  const flowsOver = new Map<string, number[]>();
  const flowsAt = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, id: string, index: number) => {
    const list = map.get(id);
    if (!list) map.set(id, [index]);
    else if (list[list.length - 1] !== index) list.push(index);
  };
  flows.forEach((flow, index) => {
    for (const edge of flow.steps.flat()) {
      add(flowsOver, edge.id, index);
      add(flowsAt, edge.source, index);
      add(flowsAt, edge.target, index);
    }
    for (const step of flow.flow.steps) for (const id of step.extraNodeIds ?? []) add(flowsAt, id, index);
  });
  return { reached, arrivals, unreached, stale, entries: new Set(analysis.entries), routeOrder: new Map(baseline.map((item, index) => [item, index])), breaks, flowsOver, flowsAt };
}

/** A shape that runs and that work reaches, or that starts it. */
function takesPartIn(analysis: TrafficAnalysis, id: string): boolean {
  const node = analysis.nodes.get(id);
  return !!node && node.role !== 'excluded' && node.role !== 'junction' && (node.isEntry || node.paths.possible > 0);
}

/**
 * One reading: the whole of it, or with `reach` (a review's) the glance a review keeps of it, for
 * which only what the outage changes is visited.
 */
function readOutage(graph: Graph, flows: readonly FlowSteps[], target: OutageTarget, reach: null): Outage | null;
function readOutage(graph: Graph, flows: readonly FlowSteps[], target: OutageTarget, reach: Reach): OutageGlance | null;
function readOutage(graph: Graph, flows: readonly FlowSteps[], target: OutageTarget, reach: Reach | null): Outage | OutageGlance | null {
  const { analysis, nodes, edges, drawn, edgeById, baseline, into, outOf, escapes } = graph;
  // A connector down is a partition: both ends run, and the work that travelled it does not. It is
  // read by the same rules as a shape down, applied to that one route instead of to everything
  // that reaches a shape.
  const severed = target.connector ? edgeById.get(target.id) : undefined;
  // A review takes every connector down, so it indexes them; one reading looks once.
  const cut = new Set(!severed ? [] : reach ? graph.carrying(severed.id) : analysis.interactions.filter((item) => item.edgeIds.includes(severed.id)));
  const targetNode = target.connector ? undefined : drawn.get(target.id);
  const lost = targetNode ? graph.lostBy(target.id).filter((id) => analysis.nodes.has(id)) : [];
  // A dead-letter or fallback route carries nothing until something fails, and can still be severed.
  if (target.connector ? ![...cut].some((item) => item.paths.possible > 0 || item.class === 'failure') : !targetNode || lost.length === 0) return null;
  const down = new Set(lost);
  /** This route no longer arrives: what it leads to is down, or the connector it runs over is. */
  const gone = (item: TrafficInteraction) => down.has(item.to) || cut.has(item);

  // A review names the same shapes again and again; one reading names each about once.
  const name = reach ? graph.name : (id: string) => outageNameOf(drawn.get(id));
  const roleOf = (id: string) => analysis.nodes.get(id)?.role;
  const categoryAt = (id: string) => {
    const node = drawn.get(id);
    return node ? categoryOf(node) : undefined;
  };
  // The far ends of the work the connector carried, which may lie past a junction it runs into.
  const ends = severed ? { from: [...new Set([...cut].map((item) => item.from))], to: [...new Set([...cut].map((item) => item.to))] } : undefined;
  const fromName = ends ? listOf(ends.from.map(name)) : '';
  const toName = ends ? listOf(ends.to.map(name)) : '';
  // A trunk leads to several shapes, and the sentences about its far end have to agree with that.
  const far = ends && ends.to.length > 1 ? { it: 'them', they: 'they', gets: 'get', its: 'their' } : { it: 'it', they: 'it', gets: 'gets', its: 'its' };
  const targetName = ends ? `the connection from ${fromName} to ${toName}` : name(target.id);
  const outName = targetNode?.type === 'group' ? `everything in ${targetName}` : targetName;
  /** How a shape that work can no longer reach is spoken of: it is down, or it is only cut off. */
  const away = (id: string) => (severed ? `${name(id)} can't be reached` : `${name(id)} is down`);
  const meanwhile = severed ? "while it couldn't be reached" : 'while it was down';

  const state = new Map<string, OutageState>();
  const edgeState = new Map<string, OutageEdgeState>();
  const notes: OutageNote[] = [];
  const takesPart = (id: string) => takesPartIn(analysis, id);
  const finish = (headline: string, instances?: Outage['instances']): Outage => ({
    target: target.id,
    ...(ends ? { connector: ends } : {}),
    lost,
    ...(instances ? { instances } : {}),
    headline,
    nodes: state,
    edges: edgeState,
    notes,
    // One instance of several changes nothing drawn, so no flow meets anything that is down.
    flows: flowsThrough(flows, edgeState, instances ? new Set() : down, name, outName),
  });
  /** What a review keeps of the reading, which `finish` would give in full: `breaks` says which
   *  flows break, by their place in the list. */
  const glance = (affected: number, breaks: (index: number) => boolean, asked = 0, instances?: Outage['instances']): OutageGlance => ({
    target: target.id,
    ...(ends ? { connector: ends } : {}),
    ...(instances ? { instances } : {}),
    affected,
    reaches: [...state].filter(([id, value]) => value === 'failing' && roleOf(id) === 'origin').map(([id]) => id),
    breaks: flows.filter((_, index) => breaks(index)).map(({ flow, title }) => ({ id: flow.id, title })),
    questions: notes.filter((note) => note.tone === 'question').length + asked,
  });

  // A Service drawn with several instances loses one before it loses all of them.
  const instanceCount = targetNode?.type === 'service' ? (targetNode.replicas ?? 1) : 1;
  if (instanceCount >= 2 && !target.whole) {
    // Everything else carries on, which a review's reading leaves unsaid.
    if (!reach) for (const node of analysis.nodes.values()) if (takesPart(node.id)) state.set(node.id, 'unaffected');
    state.set(target.id, 'degraded');
    const left = instanceCount - 1;
    const others = left === 1 ? 'the other keeps' : `the other ${left} keep`;
    const feeds = (into.get(target.id) ?? []).filter((item) => item.class === 'deliver').map((item) => item.from);
    notes.push({
      id: `instances:${target.id}`,
      tone: 'shield',
      note: `${left} of ${instanceCount} still running`,
      text: feeds.length > 0
        ? `${targetName} is drawn with ${instanceCount} instances, so ${others} taking work from ${listOf(feeds.map(name))} — slower, not stopped.`
        : `${targetName} is drawn with ${instanceCount} instances, so ${others} answering — with less room than before.`,
      focus: [target.id],
    });
    const instances = { down: 1, of: instanceCount };
    // Only the Service itself reads otherwise.
    if (reach) return glance(state.size, (index) => flowBreaks(flows[index]!, edgeState, new Set()), 0, instances);
    return finish(`One of ${instanceCount} ${targetName} instances is down. Everything drawn carries on.`, instances);
  }

  for (const id of lost) state.set(id, 'down');
  const mark = (item: TrafficInteraction, value: OutageEdgeState) => {
    for (const id of item.edgeIds) if (edgeState.get(id) !== 'recovery') edgeState.set(id, value);
  };
  const semanticsOf = (item: TrafficInteraction) => item.edgeIds.map((id) => edgeById.get(id)?.semantic);
  // An unlabelled data connector may be either; a labelled one says which.
  const writes = (item: TrafficInteraction) => writesOver(item, edgeById);
  const reads = (item: TrafficInteraction) => readsOver(item, edgeById);

  // 1. Whoever waits on it fails with it, hop by hop, until a fallback or a partial route stops it.
  const direct: string[] = [];
  const further: string[] = [];
  const people: string[] = [];
  const partial: string[] = [];
  const fellBack: { from: string; to: string[] }[] = [];
  const failed = [...lost];
  /** One route that waits on something now failing: its caller fails with it, or is shielded. */
  const wait = (item: TrafficInteraction) => {
    const at = item.to;
    if (!waitsOn(item) || state.has(item.from)) return;
    mark(item, 'failing');
    const caller = item.from;
    const fallback = roleOf(caller) === 'messaging' ? [] : (escapes.get(caller) ?? []).filter((route) => !cut.has(route));
    if (fallback.length > 0) {
      state.set(caller, 'degraded');
      for (const route of fallback) {
        mark(route, 'recovery');
        if (!state.has(route.to)) state.set(route.to, 'catching');
      }
      fellBack.push({ from: caller, to: [...new Set(fallback.map((route) => route.to))] });
      return;
    }
    // A cache is in front of something, not the thing itself: without it a read is a miss.
    if (gone(item) && categoryAt(at) === 'cache') {
      state.set(caller, 'degraded');
      const source = (outOf.get(caller) ?? []).find((other) => other.class === 'data' && !gone(other) && categoryAt(other.to) !== 'cache' && reads(other))?.to;
      // What a product does when it restarts says nothing about a cache that never went down.
      const fact = severed ? null : outageFact(drawn.get(at));
      notes.push({
        id: `cache-miss:${caller}:${at}`,
        tone: 'question',
        note: source ? `every read falls to ${name(source)}?` : 'every read is a miss — then what?',
        text: `${name(caller)} reads ${name(at)}. Nothing drawn says whether it ${source ? `falls through to ${name(source)}, which would then take every read,` : 'falls through to the source'} or fails.${fact?.down ? ` ${fact.down}` : ''}`,
        focus: [caller],
        ask: source ? `Does ${name(caller)} fall through to ${name(source)} when ${away(at)}, and can ${name(source)} take every read?` : `What does ${name(caller)} do when ${away(at)}?`,
        ...cited(fact, 'down'),
      });
      return;
    }
    if (item.certainty === 'possible') {
      state.set(caller, 'degraded');
      partial.push(caller);
      return;
    }
    state.set(caller, 'failing');
    failed.push(caller);
    if (roleOf(caller) === 'origin') people.push(caller);
    else (gone(item) ? direct : further).push(caller);
  };
  for (const item of cut) if (item.paths.possible > 0) wait(item);
  for (let head = 0; head < failed.length; head += 1) {
    for (const item of into.get(failed[head]!) ?? []) if (!cut.has(item)) wait(item);
  }
  const failing = new Set(failed);
  if (direct.length > 0) {
    const outside = lost.length === 1 && categoryAt(lost[0]!) === 'external';
    notes.push({
      id: `no-fallback:${direct.join(',')}`,
      tone: 'question',
      note: 'calls fail — no fallback drawn',
      text: `${listOf(direct.map(name))} ${direct.length === 1 ? 'waits' : 'wait'} on ${ends ? `${toName} and can't reach ${far.it}` : outName}, and nothing drawn says what happens instead.${outside ? ` ${targetName} is outside your system, so its recovery isn't yours to speed up.` : ''}`,
      focus: direct,
      ask: ends ? `What should ${name(direct[0]!)} do while it can't reach ${toName}?` : `What should ${name(direct[0]!)} do while ${targetName} is down?`,
    });
    // The retries the failing callers make, in the order the analysis lists them.
    const hammering = direct
      .flatMap((caller) => graph.retriesFrom(caller))
      .filter((item) => gone(item) || (!!ends && ends.from.includes(item.from) && ends.to.includes(item.to)))
      .sort((a, b) => graph.orderOf(a) - graph.orderOf(b));
    if (hammering.length > 0) {
      for (const item of hammering) mark(item, 'failing');
      const callers = [...new Set(hammering.map((item) => item.from))];
      notes.push({
        id: `retries:${callers.join(',')}`,
        tone: 'effect',
        note: 'retries pile onto it',
        text: ends
          ? `${listOf(callers.map(name))} ${callers.length === 1 ? 'retries' : 'retry'} as drawn, so once ${far.they} can be reached again ${toName} ${far.gets} ${far.its} normal work plus every retry that queued up meanwhile.`
          : `${listOf(callers.map(name))} ${callers.length === 1 ? 'retries' : 'retry'} as drawn, so ${targetName} comes back to its normal work plus every retry that queued up meanwhile.`,
        focus: callers,
      });
    }
  }
  if (further.length > 0) {
    notes.push({
      id: `chain:${further.join(',')}`,
      tone: 'effect',
      note: further.length === 1 ? 'fails with it' : 'fail with it',
      text: `${listOf(further.map(name))} ${further.length === 1 ? 'waits' : 'wait'} on something that is failing, so the failure travels back up the chain.`,
      focus: further,
    });
  }
  for (const { from, to } of fellBack) {
    notes.push({
      id: `fallback:${from}`,
      tone: 'shield',
      note: `falls back to ${listOf(to.map(name))}`,
      text: `${name(from)} has a fallback drawn, so the failure stops here.`,
      focus: [from],
    });
  }
  if (partial.length > 0) {
    notes.push({
      id: `partial:${partial.join(',')}`,
      tone: 'effect',
      note: 'some requests fail',
      text: `Only one of the routes out of ${listOf(partial.map(name))} leads to ${outName}; the rest get through. The drawing doesn't say what share that is.`,
      focus: partial,
    });
  }
  if (people.length > 0) {
    notes.push({
      id: `people:${people.join(',')}`,
      tone: 'effect',
      note: people.length === 1 ? 'sees the failure' : 'see the failure',
      text: `${listOf(people.map(name))} ${people.length === 1 ? 'is' : 'are'} at the start of a chain that waits on ${ends ? `${toName}, which ${fromName} can't reach` : outName}.`,
      focus: people,
    });
  }

  // 2. Messaging in front of the outage absorbs it: it holds for a consumer that is down, and
  //    redelivers to one that is failing — into a dead-letter queue where one is drawn.
  /** A delivery read once, the first time its queue is met: who hands to whom, and what the
   *  product the queue is drawn as is documented to do with a message meanwhile. */
  const delivery = (item: TrafficInteraction) => {
    if (item.class !== 'deliver' || state.has(item.from)) return null;
    const fact = outageFact(drawn.get(item.from));
    return { queue: item.from, consumer: item.to, category: categoryAt(item.from), fact, said: fact?.holding ? ` ${fact.holding}` : '', cite: cited(fact, 'holding') };
  };
  /** Messaging that can't hand a message over: its consumer is down, or cut off from it. */
  const held = (item: TrafficInteraction) => {
    const read = delivery(item);
    if (!read) return;
    const { queue, consumer, category, fact, said, cite } = read;
    mark(item, 'stopped');
    // Messaging feeding messaging (a topic into a queue that is down) has no stated behaviour.
    if (roleOf(consumer) === 'messaging') {
      state.set(queue, 'degraded');
      notes.push({
        id: `undelivered:${queue}`,
        tone: 'question',
        note: "can't deliver — held or lost?",
        text: `${name(queue)} hands messages to ${name(consumer)}. Nothing drawn says whether they wait or are dropped.${said}`,
        focus: [queue],
        ask: `What happens to messages ${name(queue)} can't deliver while ${away(consumer)}?`,
        ...cite,
      });
      return;
    }
    // A work queue hands each message to one consumer, so another consumer still drains it.
    const others = (outOf.get(queue) ?? []).filter((other) => other.class === 'deliver' && !cut.has(other) && !failing.has(other.to)).map((other) => other.to);
    if (category !== undefined && QUEUES.has(category) && others.length > 0) {
      notes.push({
        id: `shared:${queue}`,
        tone: 'shield',
        note: `${listOf(others.map(name))} ${others.length === 1 ? 'keeps' : 'keep'} draining it`,
        text: `${name(queue)} hands each message to one consumer, so ${listOf(others.map(name))} ${others.length === 1 ? 'takes' : 'take'} what ${name(consumer)} would have.`,
        focus: [queue],
      });
      return;
    }
    // A queue or a stream keeps what arrives. A topic does only if the product it is drawn as does.
    const keeps = category === 'topic' ? fact?.retains : true;
    if (keeps !== true) {
      state.set(queue, 'degraded');
      notes.push({
        id: `missed:${queue}:${consumer}`,
        tone: 'question',
        note: keeps === false ? 'events are dropped meanwhile' : 'keeps events for it, or drops them?',
        text: `${name(consumer)} subscribes to ${name(queue)} directly, with no queue of its own in between.${said || " Nothing drawn says whether a topic keeps what a subscriber wasn't there for."}`,
        focus: [queue],
        ask: `How does ${name(consumer)} catch up on what ${name(queue)} published ${meanwhile}?`,
        ...cite,
      });
      return;
    }
    state.set(queue, 'holding');
    const burst = [...new Set((outOf.get(consumer) ?? []).filter(waitsOn).map((next) => next.to))];
    // Without a product there is no documented retention to state, and "until it's back" would
    // promise the queue outlasts any outage. Every queue and log has a limit; say it isn't drawn.
    const limit = said || " Nothing drawn says how long or how much it keeps; past that, messages are lost or producers are turned away.";
    notes.push({
      id: `holding:${queue}`,
      tone: 'shield',
      note: `${category === 'queue' || category === 'deadLetter' ? 'holds messages' : 'keeps the log'} while it's ${severed ? 'cut off' : 'down'}`,
      text: `${name(queue)} keeps what arrives while ${away(consumer)}, so nothing upstream waits on it.${limit} When ${severed ? 'the connection' : 'it'} returns the backlog arrives at once${burst.length > 0 ? `, and ${listOf(burst.map(name))} ${burst.length === 1 ? 'takes' : 'take'} it with it` : ''}.`,
      focus: [queue],
      ...cite,
    });
  };
  /** Messaging whose consumer is up but failing: every message comes back. */
  const redelivered = (item: TrafficInteraction) => {
    const read = delivery(item);
    if (!read) return;
    const { queue, consumer, category, said, cite } = read;
    mark(item, 'failing');
    state.set(queue, 'retrying');
    const deadLetters = (escapes.get(queue) ?? []).filter((route) => !cut.has(route));
    if (deadLetters.length === 0) {
      notes.push({
        id: `redelivers:${queue}`,
        tone: 'question',
        note: 'keeps redelivering — no dead-letter drawn',
        text: `${name(consumer)} can't finish its work, so ${name(queue)} gets every message back. Nothing drawn says where they go after that.${said}`,
        focus: [queue],
        ask: `What happens to messages ${name(consumer)} keeps failing while ${targetName} is down?`,
        ...(category === 'queue' ? { fix: { kind: 'dead-letter' as const, queue } } : {}),
        ...cite,
      });
      return;
    }
    const attempts = deadLetters.flatMap((route) => route.edgeIds.map((id) => edgeById.get(id)?.deliveryAttempts)).find((count) => count !== undefined);
    notes.push({
      id: `dead-letters:${queue}`,
      tone: 'effect',
      note: attempts ? `dead-letters after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}` : 'retries, then dead-letters',
      text: `${name(consumer)} can't finish its work, so ${name(queue)} redelivers and then sets the message aside, as drawn.${said}`,
      focus: [queue],
      ...cite,
    });
    for (const route of deadLetters) {
      mark(route, 'recovery');
      const dlq = route.to;
      if (state.has(dlq)) continue;
      state.set(dlq, 'catching');
      notes.push(graph.replays(dlq)
        ? {
            id: `replay:${dlq}`,
            tone: 'shield',
            note: "replay from here once it's back",
            text: `Failed messages wait in ${name(dlq)}, and a replay route is drawn out of it.`,
            focus: [dlq],
          }
        : {
            id: `no-replay:${dlq}`,
            tone: 'question',
            note: 'messages stay here — no replay drawn',
            text: `Failed messages end up in ${name(dlq)}. Nothing drawn brings them back once ${targetName} recovers.`,
            focus: [dlq],
            ask: `How are messages in ${name(dlq)} replayed once ${targetName} is back?`,
            fix: { kind: 'replay', from: dlq, to: queue },
          });
    }
  };
  for (const item of cut) if (item.paths.possible > 0) held(item);
  for (const consumer of failed) {
    if (roleOf(consumer) === 'origin') continue;
    for (const item of into.get(consumer) ?? []) {
      if (cut.has(item)) continue;
      if (down.has(consumer)) held(item);
      else redelivered(item);
    }
  }

  // 3. Work a failure catches half-done. Only what the drawing says changes something counts: a
  //    labelled write, a publish, a command, or a call someone drew a recovery action for. A plain
  //    call may be a question asked, and an unlabelled data connector may be a read.
  const lasting = (item: TrafficInteraction) =>
    item.paths.possible > 0 &&
    !gone(item) &&
    state.get(item.to) !== 'failing' &&
    state.get(item.to) !== 'down' &&
    (item.class === 'publish' ||
      (item.class === 'data' && semanticsOf(item).some((semantic) => !!semantic && WRITES.has(semantic))) ||
      (item.class === 'request' && (semanticsOf(item).includes('command') || item.edgeIds.some((id) => linkedCompensations(edges, id).length > 0))));
  const doing = (item: TrafficInteraction) => `${item.class === 'publish' ? 'publishes to' : item.class === 'data' ? 'writes to' : 'calls'} ${name(item.to)}`;
  /**
   * What `from` does that lasts, and is not shown to come after the step that breaks. `flow` names
   * the flow that puts it before; without one the order is not drawn, and the reading must say so.
   */
  const halfDone = (from: string, breaking: readonly TrafficInteraction[]) => {
    const found: { item: TrafficInteraction; flow?: string }[] = [];
    // Where each flow first shows the step that breaks, worked out once for all `from` does.
    const theirs: (number | undefined)[] = [];
    for (const item of outOf.get(from) ?? []) {
      if (breaking.includes(item) || !lasting(item)) continue;
      let before: string | undefined;
      let after = false;
      for (let index = 0; index < flows.length; index += 1) {
        const flow = flows[index]!;
        const mine = stepOf(flow, item);
        if (mine === Infinity) continue;
        const breaks = (theirs[index] ??= Math.min(Infinity, ...breaking.map((other) => stepOf(flow, other))));
        if (breaks === Infinity || mine === breaks) continue;
        if (mine < breaks) before ??= flow.title;
        else after = true;
      }
      // Every flow that shows both puts it after the break: it never happens, so nothing is half-done.
      if (after && !before) continue;
      found.push({ item, ...(before ? { flow: before } : {}) });
    }
    return found;
  };
  /** The recovery actions drawn for a step, where they can still be carried out. */
  const undoing = (item: TrafficInteraction) =>
    item.edgeIds.flatMap((id) => linkedCompensations(edges, id)).filter((edge) => !down.has(edge.target) && !down.has(edge.source) && edge.id !== severed?.id);

  // A shape that fails on one step may have finished another. A queue that redelivers runs that
  // work again; with no queue, the question is what undoes it.
  for (const caller of failed) {
    if (down.has(caller) || roleOf(caller) !== 'compute') continue;
    const breaking = (outOf.get(caller) ?? []).filter((item) => waitsOn(item) && (gone(item) || state.get(item.to) === 'failing'));
    if (breaking.length === 0) continue;
    const done = halfDone(caller, breaking);
    if (done.length === 0) continue;
    const broke = listOf([...new Set(breaking.map((item) => name(item.to)))]);
    // "Has happened" only where a flow orders every step named; otherwise the note says "if".
    const ordered = done.every((entry) => entry.flow) ? done[0]!.flow : undefined;
    const did = listOf(done.map((entry) => doing(entry.item)));
    const redelivering = (into.get(caller) ?? []).find((item) => item.class === 'deliver' && state.get(item.from) === 'retrying')?.from;
    if (redelivering) {
      notes.push({
        id: `repeats:${caller}`,
        tone: 'question',
        note: 'runs again on each redelivery',
        text: ordered
          ? `${name(redelivering)} hands ${name(caller)} the same message again each time it fails. In ${ordered}, ${name(caller)} ${did} before the step that waits on ${broke}, so that is repeated on every delivery.`
          : `${name(redelivering)} hands ${name(caller)} the same message again each time it fails. ${name(caller)} also ${did}; if that comes before the step that waits on ${broke}, it is repeated on every delivery. The drawing doesn't say which comes first.`,
        focus: [caller],
        ask: `Is ${name(caller)} safe to run more than once on the same message?`,
      });
      continue;
    }
    const open = done.filter((entry) => undoing(entry.item).length === 0);
    if (open.length === 0) {
      const actions = done.flatMap((entry) => undoing(entry.item));
      for (const edge of actions) if (!edgeState.has(edge.id)) edgeState.set(edge.id, 'recovery');
      const named = [...new Set(actions.map((edge) => edge.compensationName?.trim() || edge.label?.trim()).filter((value): value is string => !!value))];
      notes.push({
        id: `undone:${caller}`,
        tone: 'shield',
        note: 'a recovery action is drawn',
        text: `${name(caller)} also ${did}, and ${named.length > 0 ? `${listOf(named)} ${named.length === 1 ? 'is' : 'are'}` : 'a recovery action is'} drawn to counteract it if the step that waits on ${broke} fails afterwards.`,
        focus: [caller],
      });
      continue;
    }
    const left = listOf(open.map((entry) => doing(entry.item)));
    const known = open.every((entry) => entry.flow) ? open[0]!.flow : undefined;
    notes.push({
      id: `half-done:${caller}`,
      tone: 'question',
      note: 'half-done — what undoes it?',
      text: known
        ? `In ${known}, ${name(caller)} ${left} before the step that waits on ${broke}, so that has already happened when that step fails. Nothing drawn undoes it.`
        : `${name(caller)} also ${left}. If that comes before the step that waits on ${broke}, it has already happened when that step fails; the drawing doesn't say which comes first, or what undoes it.`,
      focus: [caller],
      ask: `What undoes what ${name(caller)} has already done when the step that waits on ${broke} fails?`,
    });
  }

  // 4. Messaging that is down, or cut off, takes its producers' hand-off with it, and a
  //    dead-letter queue that can't be reached leaves failures with nowhere to go. Neither has a
  //    drawn answer.
  const refused = (id: string, publishing: TrafficInteraction[], fact?: OutageFact | null) => {
    const publishers = [...new Set(publishing.filter((item) => !state.has(item.from)).map((item) => item.from))];
    for (const item of publishing) mark(item, 'failing');
    for (const publisher of publishers) state.set(publisher, 'degraded');
    if (publishers.length === 0) return;
    // A publisher that also writes somewhere has two records to keep in step, and one just failed.
    const apart = publishers.flatMap((publisher) =>
      halfDone(publisher, publishing.filter((item) => item.from === publisher))
        .filter((entry) => entry.item.class !== 'publish' && undoing(entry.item).length === 0)
        .map((entry) => `${name(publisher)} also ${doing(entry.item)}${entry.flow ? `, before this in ${entry.flow}` : ''}`),
    );
    const split = apart.length === 0 ? '' : ` ${listOf(apart)}; nothing drawn keeps ${apart.length === 1 ? 'that' : 'those'} and the message in step.`;
    notes.push({
      id: `cannot-publish:${publishers.join(',')}`,
      tone: 'question',
      note: "can't publish — then what?",
      text: `${listOf(publishers.map(name))} ${publishers.length === 1 ? 'hands' : 'hand'} work to ${name(id)}. Nothing drawn says what becomes of a message it can't ${severed ? 'get there' : 'accept'}.${split}${fact?.down ? ` ${fact.down}` : ''}`,
      focus: publishers,
      ask: `What does ${name(publishers[0]!)} do with a message it can't publish to ${name(id)}?`,
      ...cited(fact, 'down'),
    });
  };
  const stranding = (id: string, routes: readonly TrafficInteraction[]) => {
    const stranded = [...new Set(routes.filter((item) => !down.has(item.from)).map((item) => item.from))];
    if (stranded.length === 0) return;
    for (const item of routes) mark(item, 'failing');
    notes.push({
      id: `nowhere:${stranded.join(',')}`,
      tone: 'question',
      note: 'failures have nowhere to go',
      text: `${listOf(stranded.map(name))} ${stranded.length === 1 ? 'sends' : 'send'} what fails to ${name(id)}.`,
      focus: stranded,
      ask: `Where do failed messages from ${name(stranded[0]!)} go while ${away(id)}?`,
    });
  };
  for (const id of lost) {
    if (roleOf(id) !== 'messaging') continue;
    refused(id, (into.get(id) ?? []).filter((item) => item.class === 'publish'), outageFact(drawn.get(id)));
    stranding(id, graph.failuresInto(id));
  }
  // What a broker does when it restarts says nothing about one that never went down.
  for (const id of ends?.to ?? []) {
    refused(id, [...cut].filter((item) => item.to === id && item.class === 'publish' && item.paths.possible > 0));
    stranding(id, [...cut].filter((item) => item.to === id && item.class === 'failure'));
  }
  // A call nobody waits on fails without anyone hearing of it: the caller carries on, and the
  // drawing is silent on the calls themselves. True of a shape that is down as of a severed route.
  const unanswered = (severed ? [...cut] : lost.flatMap((id) => into.get(id) ?? [])).filter(
    (item) => item.class === 'request' && !item.sync && item.paths.possible > 0 && !state.has(item.from),
  );
  for (const [to, calls] of group(unanswered, (item) => item.to)) {
    const callers = [...new Set(calls.map((item) => item.from))];
    for (const item of calls) mark(item, 'failing');
    for (const caller of callers) state.set(caller, 'degraded');
    notes.push({
      id: `unheard:${callers.join(',')}:${to}`,
      tone: 'question',
      note: "calls don't arrive — then what?",
      text: `${listOf(callers.map(name))} ${callers.length === 1 ? "doesn't" : "don't"} wait on ${name(to)}, so ${callers.length === 1 ? 'it carries' : 'they carry'} on. Nothing drawn says what becomes of the calls that don't arrive.`,
      focus: callers,
      ask: `What happens to calls from ${name(callers[0]!)} that don't reach ${name(to)}?`,
    });
  }

  // Step 6's question about a single instance, asked once what the outage affects is counted.
  const single = (affected: number) => lost.length === 1 && targetNode?.type === 'service' && instanceCount === 1 && categoryAt(target.id) !== 'external' && affected > 0;

  // A review's reading stops here. What steps 5 and 6 would add, it works out from `reach` — how
  // far work reached with nothing down — visiting only what this outage changes.
  if (reach) {
    // What is no longer reached: counted down along the routes that stop arriving, from what is
    // down and from the severed connector. A shape fades once nothing still reached arrives at it.
    const faded = new Set<string>();
    const fading: string[] = [];
    const arriving = new Map<string, number>();
    const fade = (id: string) => {
      faded.add(id);
      fading.push(id);
    };
    const arrivesNoMore = (item: TrafficInteraction) => {
      if (faded.has(item.to)) return;
      const count = (arriving.get(item.to) ?? reach.arrivals.get(item.to)!) - 1;
      arriving.set(item.to, count);
      // An entry point is reached however little arrives at it.
      if (count === 0 && !reach.entries.has(item.to)) fade(item.to);
    };
    for (const id of lost) if (reach.reached.has(id) && !faded.has(id)) fade(id);
    for (const item of cut) if (item.paths.possible > 0 && reach.reached.has(item.from)) arrivesNoMore(item);
    for (let head = 0; head < fading.length; head += 1) {
      for (const item of outOf.get(fading[head]!) ?? []) if (!gone(item)) arrivesNoMore(item);
    }
    // Quiet, as step 5 reads it: takes part, nothing above said otherwise, and is not reached.
    const isQuiet = (id: string) => (reach.unreached.has(id) || faded.has(id)) && !state.has(id) && takesPart(id);
    const silent = (id: string) => down.has(id) || isQuiet(id);
    /** Step 5's test for a store that goes stale, asked of one store. */
    const stale = (id: string) => {
      if (analysis.nodes.get(id)?.role !== 'data' || state.has(id) || !takesPart(id) || isQuiet(id)) return false;
      const arrivals = (into.get(id) ?? []).filter((item) => item.class === 'data');
      const writing = arrivals.filter(writes);
      return (
        writing.length > 0 &&
        arrivals.some((item) => reads(item) && !silent(item.from) && !cut.has(item)) &&
        writing.every((item) => silent(item.from) || cut.has(item))
      );
    };
    // Only these are silent (down or quiet) where they were not with nothing down, or the other way
    // round: what is down, what fades, and an unreached shape the steps above said something of.
    // Everything else reads as it did with nothing down.
    const spoken = [...state.keys()].filter((id) => reach.unreached.has(id));
    const moved = [...lost, ...faded, ...spoken];
    const quiet = reach.unreached.size - spoken.length + [...faded].filter(isQuiet).length;
    // A store reads as it does with nothing down unless it changed, or something that writes or
    // reads it changed, or a route into it was severed.
    const changed = new Set<string>(state.keys());
    for (const id of faded) changed.add(id);
    for (const id of moved) for (const item of outOf.get(id) ?? []) if (item.class === 'data') changed.add(item.to);
    for (const item of cut) if (item.paths.possible > 0 && item.class === 'data') changed.add(item.to);
    let stores = reach.stale.size;
    for (const id of changed) stores += Number(stale(id)) - Number(reach.stale.has(id));
    const affected = [...state.values()].filter((value) => value !== 'down').length + quiet + stores;
    // So too a connector, and a flow unless one of its connectors or shapes changed.
    const reread = new Set<number>();
    if (flows.length > 0) {
      const touch = (edgeId: string) => {
        for (const index of reach.flowsOver.get(edgeId) ?? []) reread.add(index);
      };
      for (const id of edgeState.keys()) touch(id);
      for (const id of moved) for (const item of outOf.get(id) ?? []) for (const edgeId of item.edgeIds) touch(edgeId);
      for (const item of cut) for (const edgeId of item.edgeIds) touch(edgeId);
      for (const id of down) for (const index of reach.flowsAt.get(id) ?? []) reread.add(index);
    }
    // Step 5 marks a route stopped when it leaves what is down or quiet, or runs over the severed
    // connector and nothing above said anything of it — asked in the order the routes come, since
    // a route marked first has then been said something of.
    const stopped = new Map<TrafficInteraction, boolean>();
    const earlier = (item: TrafficInteraction, other: TrafficInteraction) => other.paths.possible > 0 && reach.routeOrder.get(other)! < reach.routeOrder.get(item)!;
    const stops = (item: TrafficInteraction): boolean => {
      if (!(item.paths.possible > 0)) return false;
      const known = stopped.get(item);
      if (known !== undefined) return known;
      const value =
        down.has(item.from) ||
        isQuiet(item.from) ||
        (cut.has(item) && item.edgeIds.every((id) => !edgeState.has(id) && !graph.carrying(id).some((other) => earlier(item, other) && stops(other))));
      stopped.set(item, value);
      return value;
    };
    // What step 5 leaves on a connector, asked only of the ones a flow read again goes over.
    const settled = new Map<string, OutageEdgeState | undefined>();
    const afterwards: EdgeStates = {
      get: (id: string) => {
        if (settled.has(id)) return settled.get(id);
        const said = edgeState.get(id);
        const value = said !== 'recovery' && graph.carrying(id).some(stops) ? 'stopped' : said;
        settled.set(id, value);
        return value;
      },
    };
    const breaks = (index: number) => (reread.has(index) ? flowBreaks(flows[index]!, afterwards, down) : reach.breaks[index]!);
    return glance(affected, breaks, Number(single(affected)));
  }

  // 5. Whatever work only reached through it goes quiet, and a store that is still read but no
  //    longer written goes stale.
  const reached = new Set<string>();
  const pending = analysis.entries.filter((id) => !down.has(id));
  for (let head = 0; head < pending.length; head += 1) {
    const at = pending[head]!;
    if (reached.has(at)) continue;
    reached.add(at);
    for (const item of outOf.get(at) ?? []) if (!gone(item)) pending.push(item.to);
  }
  const quiet: string[] = [];
  for (const node of analysis.nodes.values()) {
    if (state.has(node.id) || !takesPart(node.id)) continue;
    if (reached.has(node.id)) state.set(node.id, 'unaffected');
    else {
      state.set(node.id, 'quiet');
      quiet.push(node.id);
    }
  }
  for (const item of baseline) {
    const from = state.get(item.from);
    // Whatever the rules above left unsaid about the severed connector: nothing travels it.
    if (from === 'down' || from === 'quiet' || (cut.has(item) && !item.edgeIds.some((id) => edgeState.has(id)))) mark(item, 'stopped');
  }
  const silent = (id: string) => state.get(id) === 'down' || state.get(id) === 'quiet';
  for (const node of analysis.nodes.values()) {
    if (node.role !== 'data' || state.get(node.id) !== 'unaffected') continue;
    const arrivals = (into.get(node.id) ?? []).filter((item) => item.class === 'data');
    const writing = arrivals.filter(writes);
    const writers = [...new Set(writing.map((item) => item.from))];
    const readers = [...new Set(arrivals.filter((item) => reads(item) && !silent(item.from) && !cut.has(item)).map((item) => item.from))];
    // A writer that runs but can no longer reach the store writes nothing to it either.
    if (writers.length === 0 || readers.length === 0 || !writing.every((item) => silent(item.from) || cut.has(item))) continue;
    state.set(node.id, 'stale');
    notes.push({
      id: `stale:${node.id}`,
      tone: 'effect',
      note: 'goes stale',
      text: `${listOf(writers.map(name))} ${writers.length === 1 ? 'is' : 'are'} what ${writers.length === 1 ? 'writes' : 'write'} to ${name(node.id)}, so ${listOf(readers.map(name))} ${readers.length === 1 ? 'keeps' : 'keep'} reading what was there when ${outName} went down.`,
      focus: [node.id],
    });
  }
  if (quiet.length > 0) {
    const stores = quiet.every((id) => roleOf(id) === 'data');
    // A store nobody reaches is no longer updated only if something wrote to it; one that was
    // only read is simply no longer read.
    const written = quiet.some((id) => (into.get(id) ?? []).some((item) => item.class === 'data' && writes(item)));
    const scheduled = lost.length === 1 && categoryAt(lost[0]!) === 'scheduler';
    notes.push({
      id: `quiet:${quiet.join(',')}`,
      tone: 'effect',
      note: stores ? (written ? 'stops being updated' : 'is no longer read') : scheduled ? 'never starts' : 'nothing arrives',
      text: `Everything that reaches ${listOf(quiet.map(name))} comes through ${outName}.`,
      focus: quiet.slice(0, 4),
    });
  }

  // 6. One instance drawn, and something depends on it.
  const affected = [...state.values()].filter((value) => value !== 'unaffected' && value !== 'down').length;
  if (single(affected)) {
    notes.push({
      id: `single:${target.id}`,
      tone: 'question',
      note: 'one instance drawn',
      text: `${targetName} is drawn as a single instance, so nothing takes over when it goes.`,
      focus: [target.id],
      ask: `Should ${targetName} run more than one instance?`,
      fix: { kind: 'instances', node: target.id },
    });
  }

  // Named in the order they were drawn, which is the order the diagram is read in.
  const unaffected = nodes.filter((node) => state.get(node.id) === 'unaffected').map((node) => node.id);
  const rest = unaffected.length === 0
    ? 'Nothing drawn carries on without it.'
    : affected === 0
      ? 'Nothing else drawn depends on it.'
      : `${listOf(unaffected.map(name), 2)} ${unaffected.length === 1 ? 'carries' : 'carry'} on.`;
  const subject = ends
    ? `${fromName} can't reach ${toName}.`
    : targetNode?.type === 'group'
      ? `Everything in ${targetName} is down.`
      : instanceCount >= 2
        ? `All ${instanceCount} ${targetName} instances are down.`
        : `${targetName} is down.`;
  return finish(`${subject} ${rest}`);
}

/** The walk as plain sentences — what a screen reader hears, and what an agent is handed. */
export function outageSummary(outage: Outage): string[] {
  const carryOn = outage.flows.filter((flow) => flow.state === 'unaffected').map((flow) => flow.title);
  return [
    outage.headline,
    ...outage.notes.map((note) => (note.tone === 'question' && note.ask ? `${note.text} Open: ${note.ask}` : note.text)),
    ...outage.flows.filter((flow) => flow.state !== 'unaffected').map((flow) => flow.text),
    ...(carryOn.length > 0 ? [`The ${listOf(carryOn)} ${carryOn.length === 1 ? 'flow carries' : 'flows carry'} on.`] : []),
  ];
}

/** A flow as the connectors of this graph its steps name: read once, then against each outage. */
interface FlowSteps {
  flow: DraftFlow;
  title: string;
  /** Each step's connectors that are in this graph. */
  steps: DraftEdge[][];
  /** The flow's connectors by the shape they leave. */
  leaving: Map<string, DraftEdge[]>;
  /** The step at which each connector the flow names first appears, and so each interaction
   *  (`stepOf`), remembered for the readings that share the flow. */
  first: Map<string, number>;
  at: Map<TrafficInteraction, number>;
}

/** The first step of the flow that shows any of the interaction's connectors; `Infinity` if none. */
function stepOf(flow: FlowSteps, item: TrafficInteraction): number {
  let at = flow.at.get(item);
  if (at === undefined) flow.at.set(item, (at = earliestStep(item.edgeIds, flow.first)));
  return at;
}

/** The first step of a flow that shows any of these connectors; `Infinity` when none does. */
function earliestStep(edgeIds: readonly string[], first: ReadonlyMap<string, number>): number {
  let at = Infinity;
  for (const id of edgeIds) {
    const step = first.get(id);
    if (step !== undefined && step < at) at = step;
  }
  return at;
}

function flowStepsOf(flows: readonly DraftFlow[], edgeById: ReadonlyMap<string, DraftEdge>): FlowSteps[] {
  return flows.map((flow) => {
    const steps = flow.steps.map((step) =>
      [step.edgeId, ...(step.extraEdgeIds ?? [])].flatMap((id) => {
        const edge = id ? edgeById.get(id) : undefined;
        return edge ? [edge] : [];
      }),
    );
    const leaving = new Map<string, DraftEdge[]>();
    for (const edge of steps.flat()) {
      const list = leaving.get(edge.source);
      if (list) list.push(edge);
      else leaving.set(edge.source, [edge]);
    }
    const first = new Map<string, number>();
    flow.steps.forEach((step, index) => {
      for (const id of [step.edgeId, ...(step.extraEdgeIds ?? [])]) if (id && !first.has(id)) first.set(id, index);
    });
    return { flow, title: flow.title.trim() || 'Untitled flow', steps, leaving, first, at: new Map() };
  });
}

/**
 * Each flow against the outage. Module-level, and handed only what it reads, so the reading it
 * returns holds none of `outageOf`'s working sets.
 */
function flowsThrough(
  flows: readonly FlowSteps[],
  edgeState: EdgeStates,
  down: ReadonlySet<string>,
  name: (id: string) => string,
  outName: string,
): OutageFlow[] {
  const read: OutageFlow[] = [];
  for (const flow of flows) {
    const reading = flowThrough(flow, edgeState, down, name, outName);
    if (reading) read.push(reading);
  }
  return read;
}

/** A flow that names no connector of this graph says nothing an outage can be read against. */
function readsNothing({ flow, steps }: FlowSteps, down: ReadonlySet<string>): boolean {
  return steps.every((edges) => edges.length === 0) && !flow.steps.some((step) => (step.extraNodeIds ?? []).some((id) => down.has(id)));
}

type Verdict = 'fails' | 'stops' | null;

/**
 * What the outage does to each of a flow's connectors on this journey. What the walk says of a
 * connector stands, with one refinement only a flow can make. A caller fails because *something*
 * it waits on fails; the flow says what it does on this journey. So where the flow goes on from
 * the shape a failing call reaches, the call fails here only if one of those next steps does.
 * Where the flow says nothing further, the call fails as the walk reads.
 */
function verdictsOf({ leaving }: FlowSteps, edgeState: EdgeStates, down: ReadonlySet<string>): (edge: DraftEdge) => Verdict {
  const verdicts = new Map<string, Verdict>();
  const verdict = (edge: DraftEdge): Verdict => {
    const known = verdicts.get(edge.id);
    if (known !== undefined) return known;
    // Held while its own next steps are read, so a loop of calls ends.
    verdicts.set(edge.id, null);
    const state = edgeState.get(edge.id);
    let result: Verdict = null;
    if (state === 'stopped') result = 'stops';
    // A connector the walk leaves unmarked (a call nobody waits on) still cannot happen when it
    // touches what is down: sent to it, the call fails; from it, nothing leaves.
    else if (state === undefined) result = down.has(edge.target) ? 'fails' : down.has(edge.source) ? 'stops' : null;
    else if (state === 'failing') {
      const next = down.has(edge.target) ? [] : (leaving.get(edge.target) ?? []);
      result = next.length === 0 || next.some((other) => verdict(other) !== null) ? 'fails' : null;
    }
    verdicts.set(edge.id, result);
    return result;
  };
  return verdict;
}

/** Whether `flowThrough` reads the flow as breaking: the same verdicts, read in the same order, as
 *  far as the first step that cannot happen — without the sentence a review does not read. */
function flowBreaks(prepared: FlowSteps, edgeState: EdgeStates, down: ReadonlySet<string>): boolean {
  if (readsNothing(prepared, down)) return false;
  const verdict = verdictsOf(prepared, edgeState, down);
  return prepared.flow.steps.some((step, index) => prepared.steps[index]!.map(verdict).some((value) => value !== null) || (step.extraNodeIds ?? []).some((id) => down.has(id)));
}

/** One flow against the outage, or `null` when it names nothing an outage can be read against. */
function flowThrough(
  prepared: FlowSteps,
  edgeState: EdgeStates,
  down: ReadonlySet<string>,
  name: (id: string) => string,
  outName: string,
): OutageFlow | null {
  const { flow, title, steps } = prepared;
  const of = flow.steps.length;
  if (readsNothing(prepared, down)) return null;
  const verdict = verdictsOf(prepared, edgeState, down);
  let recovery = false;
  let first: { step: number; fails: boolean; label: string } | undefined;
  let later = 0;
  const sidestepped = new Set<string>();
  flow.steps.forEach((step, index) => {
    const edges = steps[index]!;
    const outcomes = edges.map(verdict);
    const shown = (step.extraNodeIds ?? []).filter((id) => down.has(id));
    if (outcomes.every((value) => value === null) && shown.length === 0) {
      if (edges.some((edge) => edgeState.get(edge.id) === 'recovery')) recovery = true;
      for (const edge of edges) if (edgeState.get(edge.id) === 'failing') sidestepped.add(edge.target);
      return;
    }
    if (first) {
      later += 1;
      return;
    }
    const primary = edges[0];
    first = { step: index + 1, fails: outcomes.includes('fails'), label: primary ? `${name(primary.source)} → ${name(primary.target)}` : shown.map(name).join(', ') };
  });
  if (first) {
    const more = later === 0 ? '' : ` ${later} later ${later === 1 ? 'step is' : 'steps are'} hit too.`;
    return {
      id: flow.id,
      title,
      state: 'breaks',
      step: first.step,
      of,
      note: `breaks at step ${first.step} of ${of}`,
      text: `Step ${first.step} of ${of} in ${title} (${first.label}) ${first.fails ? 'fails' : `doesn't happen: nothing travels it while ${outName} is down`}.${more}`,
    };
  }
  if (recovery) return { id: flow.id, title, state: 'recovery', of, note: 'comes into use', text: `${title} runs over a fallback or dead-letter route this outage brings into use.` };
  const aside = [...sidestepped].map(name);
  return {
    id: flow.id,
    title,
    state: 'unaffected',
    of,
    note: 'carries on',
    text: aside.length === 0 ? `${title} carries on.` : `${title} carries on: ${listOf(aside)} ${aside.length === 1 ? 'fails' : 'fail'} only where ${aside.length === 1 ? 'it waits' : 'they wait'} on something this flow doesn't use.`,
  };
}

function group(items: readonly TrafficInteraction[], key: (item: TrafficInteraction) => string): Map<string, TrafficInteraction[]> {
  const map = new Map<string, TrafficInteraction[]>();
  for (const item of items) {
    const list = map.get(key(item));
    if (list) list.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}

/** Names as a sentence lists them: "A", "A and B", "A, B and C", "A, B, C and 2 more". */
export function listOf(names: string[], limit = 3): string {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}
