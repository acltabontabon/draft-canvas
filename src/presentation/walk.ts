/**
 * A walk: the flow Present tells when nobody has made one.
 *
 * A flow is an order somebody gave. Until they have, the diagram still has one of its own — its
 * connectors point somewhere — so Present follows the arrows instead of showing a still picture
 * with nothing to step through. With shapes or connectors selected, the walk is about those: from
 * one shape onward, the way from one shape to another, or the selected part in arrow order.
 *
 * A walk is an ordinary `DraftFlow` that the file does not hold. It is worked out when Present is
 * pressed, lives in `flowPlayback.walk`, and reaches the document only if the presenter keeps it
 * (`editorStore.keepWalk`). The same diagram and selection always give the same walk.
 *
 * Pure: `document/` only, no React, no store.
 */
import { displayNameFor } from '../document/factory';
import { LIMITS } from '../document/limits';
import type { DraftDocument, DraftEdge, DraftFlow, DraftFlowStep, DraftNode } from '../document/types';

const PREFIX = 'walk:';

/** The ids a walk is known by — also what Present is asked for by name (`EditorScreen.onPresent`). */
export const WALK_OF_SELECTION = `${PREFIX}selection`;
export const WALK_OF_DIAGRAM = `${PREFIX}diagram`;

/** Whether a playback flow id names a walk rather than a flow the file holds. */
export const isWalkId = (flowId: string | null | undefined): boolean => Boolean(flowId?.startsWith(PREFIX));

export interface Walk {
  /** What the walk is about: what was selected, or the whole diagram. */
  about: 'selection' | 'diagram';
  flow: DraftFlow;
}

type Graph = Pick<DraftDocument, 'nodes' | 'edges'>;
interface Picked {
  nodes: readonly string[];
  edges: readonly string[];
}

/** A selection speaks for Present only when it makes a story: one connector is just a connector. */
const MIN_SELECTION_STEPS = 2;

/** Top-left first, whichever way the diagram reads: across, or down. */
const rank = (node: DraftNode): number => node.x + node.y;

/** The connectors that join two shapes the diagram really has. */
function liveEdges(graph: Graph, nodes: ReadonlyMap<string, DraftNode>): DraftEdge[] {
  return graph.edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
}

function outgoing(edges: readonly DraftEdge[]): Map<string, DraftEdge[]> {
  const out = new Map<string, DraftEdge[]>();
  for (const edge of edges) {
    const list = out.get(edge.source);
    if (list) list.push(edge);
    else out.set(edge.source, [edge]);
  }
  return out;
}

/**
 * The order a set of connectors is told in, as steps (each a list of connector ids, the first its
 * primary one).
 *
 * One path is followed to its end before the next branch is picked up, the way a person explains a
 * diagram. Connectors that say one thing together are one step: a shape pointing at several
 * dead ends ("the gateway routes to three services"), and several lone sources pointing at the
 * same shape ("three producers publish to the topic"). Every connector is told once, so a loop is
 * followed back to where it started and no further.
 */
function arrowOrder(edges: readonly DraftEdge[], nodes: ReadonlyMap<string, DraftNode>, startAt?: string): string[][] {
  const out = outgoing(edges);
  const into = new Map<string, DraftEdge[]>();
  for (const edge of edges) {
    const list = into.get(edge.target);
    if (list) list.push(edge);
    else into.set(edge.target, [edge]);
  }
  const rankOf = (id: string) => rank(nodes.get(id)!);
  for (const list of out.values()) list.sort((a, b) => rankOf(a.target) - rankOf(b.target));

  const isDeadEnd = (id: string) => !out.has(id);
  const isLoneSource = (id: string) => !into.has(id) && out.get(id)?.length === 1;

  const told = new Set<string>();
  const visited = new Set<string>();
  const steps: string[][] = [];
  const tell = (group: readonly DraftEdge[]) => {
    // A step holds its primary connector and a bounded number beside it.
    for (let at = 0; at < group.length; at += LIMITS.maxExtraMembersPerStep + 1) {
      const chunk = group.slice(at, at + LIMITS.maxExtraMembersPerStep + 1);
      for (const edge of chunk) told.add(edge.id);
      steps.push(chunk.map((edge) => edge.id));
    }
  };

  // Depth first with its own stack: a long chain must not be as deep as the call stack.
  const follow = (start: string) => {
    if (visited.has(start)) return;
    visited.add(start);
    const stack: { edges: DraftEdge[]; at: number }[] = [{ edges: out.get(start) ?? [], at: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edge = frame.edges[frame.at];
      if (!edge) {
        stack.pop();
        continue;
      }
      frame.at += 1;
      if (told.has(edge.id)) continue;
      const beside = isLoneSource(edge.source)
        ? (into.get(edge.target) ?? []).filter((other) => other !== edge && !told.has(other.id) && isLoneSource(other.source))
        : [];
      for (const other of beside) visited.add(other.source);
      if (isDeadEnd(edge.target)) {
        tell([...frame.edges.filter((other) => !told.has(other.id) && isDeadEnd(other.target)), ...beside]);
        continue;
      }
      tell([edge, ...beside]);
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      stack.push({ edges: out.get(edge.target) ?? [], at: 0 });
    }
  };

  if (startAt) follow(startAt);
  const sources = [...out.keys()].sort((a, b) => rankOf(a) - rankOf(b));
  // Where the diagram begins: shapes nothing points into. Then whatever only a loop reaches.
  for (const id of sources) if (!into.has(id)) follow(id);
  for (const id of sources) follow(id);
  return steps;
}

function flowOf(id: string, title: string, steps: readonly (readonly string[])[]): DraftFlow {
  return {
    id,
    title: title.slice(0, LIMITS.maxFlowTitleLength),
    steps: steps.slice(0, LIMITS.maxStepsPerFlow).map(
      ([edgeId, ...extra], index): DraftFlowStep => ({
        id: `${PREFIX}${index + 1}`,
        edgeId,
        ...(extra.length > 0 ? { extraEdgeIds: extra } : {}),
      }),
    ),
  };
}

/** Every connector reachable from a shape by following arrows. */
function downstream(from: string, edges: readonly DraftEdge[]): DraftEdge[] {
  const out = outgoing(edges);
  const reached = new Set<string>([from]);
  const found: DraftEdge[] = [];
  const queue = [from];
  for (let at = 0; at < queue.length; at += 1) {
    for (const edge of out.get(queue[at]!) ?? []) {
      found.push(edge);
      if (reached.has(edge.target)) continue;
      reached.add(edge.target);
      queue.push(edge.target);
    }
  }
  return found;
}

/** The shortest way from one shape to another along the arrows, or `null` when there is none. */
function pathBetween(from: string, to: string, edges: readonly DraftEdge[]): DraftEdge[] | null {
  const out = outgoing(edges);
  const cameBy = new Map<string, DraftEdge>();
  const queue = [from];
  for (let at = 0; at < queue.length; at += 1) {
    const here = queue[at]!;
    if (here === to) break;
    for (const edge of out.get(here) ?? []) {
      if (edge.target === from || cameBy.has(edge.target)) continue;
      cameBy.set(edge.target, edge);
      queue.push(edge.target);
    }
  }
  if (!cameBy.has(to)) return null;
  const path: DraftEdge[] = [];
  for (let at = to; at !== from; ) {
    const edge = cameBy.get(at)!;
    path.unshift(edge);
    at = edge.source;
  }
  return path;
}

/** Selected shapes, with everything inside a selected boundary: selecting a boundary means its contents. */
function withContents(picked: readonly string[], graph: Graph): Set<string> {
  const chosen = new Set(picked);
  const parents = new Map(graph.nodes.map((node) => [node.id, node.parentId]));
  for (const node of graph.nodes) {
    for (let up = node.parentId, hops = 0; up && hops < 64; up = parents.get(up), hops += 1) {
      if (chosen.has(up)) {
        chosen.add(node.id);
        break;
      }
    }
  }
  return chosen;
}

/** Whether the steps are one unbroken chain — the only shape of walk that has a "from" and a "to". */
function endsOf(steps: readonly (readonly string[])[], edges: ReadonlyMap<string, DraftEdge>): [string, string] | null {
  let at: string | undefined;
  for (const step of steps) {
    const edge = edges.get(step[0]!)!;
    if (step.length > 1 || (at !== undefined && edge.source !== at)) return null;
    at = edge.target;
  }
  const first = steps[0] && edges.get(steps[0][0]!);
  return first && at !== undefined && first.source !== at ? [first.source, at] : null;
}

/**
 * The walk a selection asks for, or `null` when it asks for none (nothing selected, or too little
 * to make a story — Present then does what it does with nothing selected).
 *
 * - one shape: from it onward, along its arrows;
 * - two shapes: the way from one to the other;
 * - anything else: the selected connectors and the ones among the selected shapes, in arrow order
 *   — unless that is every connector there is, which is the whole diagram and no selection at all.
 */
export function walkOfSelection(graph: Graph, picked: Picked): Walk | null {
  if (picked.nodes.length === 0 && picked.edges.length === 0) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = liveEdges(graph, nodes);
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const name = (id: string) => displayNameFor(nodes.get(id)!);
  const made = (title: string, steps: string[][]): Walk | null =>
    steps.length >= MIN_SELECTION_STEPS ? { about: 'selection', flow: flowOf(WALK_OF_SELECTION, title, steps) } : null;

  const shapes = picked.nodes.filter((id) => nodes.has(id));
  if (picked.edges.length === 0 && shapes.length === 1 && nodes.get(shapes[0]!)!.type !== 'group') {
    const from = shapes[0]!;
    return made(`From ${name(from)}`, arrowOrder(downstream(from, edges), nodes, from));
  }
  if (picked.edges.length === 0 && shapes.length === 2) {
    const [a, b] = [...shapes].sort((x, y) => rank(nodes.get(x)!) - rank(nodes.get(y)!)) as [string, string];
    const path = pathBetween(a, b, edges) ?? pathBetween(b, a, edges);
    if (path && path.length >= MIN_SELECTION_STEPS) {
      return made(`${name(path[0]!.source)} to ${name(path[path.length - 1]!.target)}`, path.map((edge) => [edge.id]));
    }
  }
  const inside = withContents(shapes, graph);
  const chosen = new Set(picked.edges);
  const among = edges.filter((edge) => chosen.has(edge.id) || (inside.has(edge.source) && inside.has(edge.target)));
  // Everything selected is not a choice of part: it is what select-all and a freshly inserted
  // starter leave behind, and Present must still offer that diagram's own flows.
  if (among.length === edges.length) return null;
  const steps = arrowOrder(among, nodes);
  const ends = endsOf(steps, byId);
  return made(ends ? `${name(ends[0])} to ${name(ends[1])}` : 'Selection', steps);
}

/** The whole diagram in arrow order, or `null` when it has no connectors to follow. */
export function walkOfDiagram(graph: Graph): Walk | null {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps = arrowOrder(liveEdges(graph, nodes), nodes);
  return steps.length > 0 ? { about: 'diagram', flow: flowOf(WALK_OF_DIAGRAM, 'Whole diagram', steps) } : null;
}

/**
 * What Present walks when it is not handed a flow: the selection when it makes a story, else a
 * saved flow when there is one to present (`null` — playback chooses it), else the whole diagram.
 */
export function walkToPresent(graph: Graph, picked: Picked, hasFlows: boolean): Walk | null {
  return walkOfSelection(graph, picked) ?? (hasFlows ? null : walkOfDiagram(graph));
}

/** A walk as a flow the file can hold: the same steps under ids of its own. */
export function flowFromWalk(walk: DraftFlow, id: string, stepId: () => string, title: string): DraftFlow {
  return {
    id,
    title: title.slice(0, LIMITS.maxFlowTitleLength),
    steps: walk.steps.map((step) => ({ ...step, id: stepId() })),
  };
}

/**
 * A walk with one connector told next — what clicking a connector does while a walk is presented,
 * so an order nobody chose becomes the one the presenter takes.
 *
 * `told` is how many steps have been told so far, the current one included (`0` in the opening).
 * A connector already told is gone back to and nothing moves. One still to come is brought forward,
 * with whatever shares its step; one the walk never had joins it. `live` is what the diagram still
 * holds: steps whose connectors are gone are dropped first, so a step's number is its place.
 *
 * Returns the walk (always a new object, so playback frames the step it lands on) and that step's
 * number, or `null` when the connector cannot be told.
 */
export function tellNext(
  walk: DraftFlow,
  edgeId: string,
  told: number,
  live: ReadonlySet<string>,
): { flow: DraftFlow; step: number } | null {
  if (!live.has(edgeId)) return null;
  const steps: DraftFlowStep[] = [];
  for (const step of walk.steps) {
    const [first, ...extra] = [step.edgeId, ...(step.extraEdgeIds ?? [])].filter((id): id is string => id !== undefined && live.has(id));
    if (first === undefined) continue;
    steps.push({ id: step.id, edgeId: first, ...(extra.length > 0 ? { extraEdgeIds: extra } : {}) });
  }
  const done = Math.max(0, Math.min(told, steps.length));
  const at = steps.findIndex((step) => step.edgeId === edgeId || step.extraEdgeIds?.includes(edgeId));
  if (at >= 0 && at < done) return { flow: { ...walk, steps }, step: at + 1 };
  if (at < 0 && steps.length >= LIMITS.maxStepsPerFlow) return null;
  const [next] = at >= 0 ? steps.splice(at, 1) : [{ id: `${PREFIX}+${edgeId}`, edgeId }];
  steps.splice(done, 0, next!);
  return { flow: { ...walk, steps }, step: done + 1 };
}
