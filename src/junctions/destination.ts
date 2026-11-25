/**
 * What is around a Junction: the answer to "what happens after this?" before anyone travels there.
 *
 * Read from the room's own connectors and nothing else. The shapes a Junction is wired to are its
 * context; shapes that merely sit nearby are not, and are only borrowed when it is wired to nothing
 * at all. Bounded on purpose: two steps out, a handful of shapes, a box no bigger than a screen can
 * show — never a walk of the whole connected architecture to answer where the camera should stop.
 *
 * Pure: a graph in, plain data out.
 */
import { displayNameFor } from '../document/factory';
import { boundsOf, type Bounds } from '../document/geometry';
import type { DraftEdge, DraftNode } from '../document/types';

/** How many shapes the context may hold beside the Junction itself. */
export const CONTEXT_LIMIT = 8;
/** How many of those may be shapes wired directly to it. */
const DIRECT_LIMIT = 6;
/** The largest box, in the room's own units, the context is allowed to grow to. */
export const CONTEXT_MAX_SPAN = { width: 2200, height: 1500 };
/** A neighbour bigger than this is scenery (a wide lane, a huge sequence), not context. */
const OVERSIZED = { width: 1400, height: 1000 };
/** With nothing wired to it, shapes within this distance are borrowed so it is not framed alone. */
const NEARBY_RADIUS = 420;
const NEARBY_LIMIT = 4;

/**
 * Which way the drawn connectors run at a Junction, when they say:
 * `continues` — they only leave it, so the flow goes on from here;
 * `arrives` — they only enter it, so the flow comes in here;
 * `through` — both. `null` when it is wired to nothing, or only by undirected lines: a direction
 * that cannot be read is never made up.
 */
export type JunctionDirection = 'continues' | 'arrives' | 'through';

export interface JunctionContext {
  /** The Junction itself. */
  node: DraftNode;
  direction: JunctionDirection | null;
  /** The shapes wired directly to it, nearest first. */
  neighbours: DraftNode[];
  /** One step past those, the way the connectors run: what the flow reaches next, or came from. */
  beyond: DraftNode[];
  /** Whether those were borrowed for being nearby, because nothing is wired to it. */
  borrowed: boolean;
  /** The innermost Boundary it sits in, if any — the section of the diagram it belongs to. */
  section: DraftNode | null;
  /** The Junction and everything framed with it. */
  contextIds: string[];
  /** The connectors among those shapes. */
  edgeIds: string[];
  /** The box the camera frames, in the room's units. */
  bounds: Bounds;
}

interface Adjacency {
  out: ReadonlyMap<string, readonly DraftEdge[]>;
  into: ReadonlyMap<string, readonly DraftEdge[]>;
}

/** A room's connectors by end, built once per connector list and dropped with it. */
const adjacencyCache = new WeakMap<readonly DraftEdge[], Adjacency>();

function adjacencyOf(edges: readonly DraftEdge[]): Adjacency {
  const cached = adjacencyCache.get(edges);
  if (cached) return cached;
  const out = new Map<string, DraftEdge[]>();
  const into = new Map<string, DraftEdge[]>();
  const add = (map: Map<string, DraftEdge[]>, key: string, edge: DraftEdge) => {
    const list = map.get(key);
    if (list) list.push(edge);
    else map.set(key, [edge]);
  };
  for (const edge of edges) {
    add(out, edge.source, edge);
    add(into, edge.target, edge);
  }
  const adjacency: Adjacency = { out, into };
  adjacencyCache.set(edges, adjacency);
  return adjacency;
}

/** A room's shapes by id, built once per shape list: a group of fifty asks fifty times. */
const byIdCache = new WeakMap<readonly DraftNode[], ReadonlyMap<string, DraftNode>>();

function nodesById(nodes: readonly DraftNode[]): ReadonlyMap<string, DraftNode> {
  const cached = byIdCache.get(nodes);
  if (cached) return cached;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  byIdCache.set(nodes, byId);
  return byId;
}

const NONE: readonly DraftEdge[] = Object.freeze([]);

const centre = (box: Bounds) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function distance(a: Bounds, b: Bounds): number {
  const from = centre(a);
  const to = centre(b);
  return Math.hypot(from.x - to.x, from.y - to.y);
}

const oversized = (node: DraftNode) => node.width > OVERSIZED.width || node.height > OVERSIZED.height;

/** Nearest first, then by id: two shapes the same distance away never swap between two reads. */
function nearestFirst(origin: Bounds) {
  return (a: DraftNode, b: DraftNode) => distance(origin, a) - distance(origin, b) || (a.id < b.id ? -1 : 1);
}

/**
 * The context of the Junction `id` in one room. `undefined` when it is not there.
 *
 * Shapes wired straight to it come first, then one more step along the way the connectors run, so
 * `(A) → Partner Adapter → External Gateway` is framed whole. A shape is taken only while the box
 * stays within `CONTEXT_MAX_SPAN`; the nearest are taken first, so what is dropped is what is
 * furthest. Boundaries are never framed for their own sake: a section can be the size of the diagram.
 */
export function junctionContext(graph: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }, id: string): JunctionContext | undefined {
  const byId = nodesById(graph.nodes);
  const node = byId.get(id);
  if (!node) return undefined;
  const { out, into } = adjacencyOf(graph.edges);
  const leaving = out.get(id) ?? NONE;
  const entering = into.get(id) ?? NONE;

  const directedOut = leaving.some((edge) => edge.directed);
  const directedIn = entering.some((edge) => edge.directed);
  const direction: JunctionDirection | null = directedOut && directedIn ? 'through' : directedOut ? 'continues' : directedIn ? 'arrives' : null;

  const framable = (other: DraftNode | undefined): other is DraftNode => other !== undefined && other.id !== id && other.type !== 'group' && !oversized(other);
  const direct = new Map<string, DraftNode>();
  for (const edge of leaving) {
    const other = byId.get(edge.target);
    if (framable(other)) direct.set(other.id, other);
  }
  for (const edge of entering) {
    const other = byId.get(edge.source);
    if (framable(other)) direct.set(other.id, other);
  }
  let neighbours = [...direct.values()].sort(nearestFirst(node)).slice(0, DIRECT_LIMIT);

  // One step further, the way the flow runs: onward from where it leaves, back from where it enters.
  const further = new Map<string, DraftNode>();
  const reach = (edges: readonly DraftEdge[], end: 'source' | 'target') => {
    for (const edge of edges) {
      const other = byId.get(edge[end]);
      if (framable(other) && !direct.has(other.id)) further.set(other.id, other);
    }
  };
  for (const neighbour of neighbours) {
    if (leaving.some((edge) => edge.target === neighbour.id)) reach(out.get(neighbour.id) ?? NONE, 'target');
    if (entering.some((edge) => edge.source === neighbour.id)) reach(into.get(neighbour.id) ?? NONE, 'source');
  }

  let borrowed = false;
  if (neighbours.length === 0) {
    // Wired to nothing: borrow what is close, so it is seen somewhere rather than alone in a void.
    // Never another Junction: "near A" explains nothing about where this one is.
    const close = graph.nodes.filter((other) => framable(other) && other.type !== 'ellipse' && distance(node, other) <= NEARBY_RADIUS).sort(nearestFirst(node));
    neighbours = close.slice(0, NEARBY_LIMIT);
    borrowed = neighbours.length > 0;
  }

  const framed: DraftNode[] = [node];
  let box: Bounds = { x: node.x, y: node.y, width: node.width, height: node.height };
  const take = (candidates: readonly DraftNode[]) => {
    for (const candidate of candidates) {
      if (framed.length > CONTEXT_LIMIT) return;
      const grown = boundsOf([box, candidate])!;
      if (grown.width > CONTEXT_MAX_SPAN.width || grown.height > CONTEXT_MAX_SPAN.height) continue;
      framed.push(candidate);
      box = grown;
    }
  };
  take(neighbours);
  const beyond = [...further.values()].sort(nearestFirst(node));
  take(beyond);

  const ids = new Set(framed.map((member) => member.id));
  // From each framed shape's own connectors, never a pass over the room's: a group drawn in a
  // hundred places asks this a hundred times.
  const edgeIds: string[] = [];
  for (const member of framed) {
    for (const edge of out.get(member.id) ?? NONE) if (ids.has(edge.target)) edgeIds.push(edge.id);
  }
  const parent = node.parentId ? byId.get(node.parentId) : undefined;

  return {
    node,
    direction,
    neighbours,
    beyond: beyond.filter((other) => framed.includes(other)),
    borrowed,
    section: parent?.type === 'group' ? parent : null,
    contextIds: framed.map((member) => member.id),
    edgeIds,
    bounds: box,
  };
}

/** "Partner Adapter, External Gateway" — up to `limit` names, then how many more. */
export function neighbourNames(context: JunctionContext, limit = 3): string {
  const names = context.neighbours.map(displayNameFor).filter((name) => name.trim());
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} +${names.length - limit}`;
}

/**
 * One line saying what a Junction leads to, in the direction the connectors give:
 * "continues to Partner Adapter", "arrives from Order Service", "between Orders and Billing".
 * Empty when it is wired to nothing.
 */
export function contextSentence(context: JunctionContext): string {
  if (context.neighbours.length === 0) return '';
  const names = neighbourNames(context);
  if (context.borrowed) return `near ${names}`;
  // With one shape either side of the story, the step after it is worth the words:
  // "continues to Partner Adapter → External Gateway".
  const next = context.neighbours.length === 1 && context.beyond.length === 1 ? displayNameFor(context.beyond[0]!).trim() : '';
  switch (context.direction) {
    case 'continues':
      return `continues to ${names}${next ? ` → ${next}` : ''}`;
    case 'arrives':
      return `arrives from ${next ? `${next} → ` : ''}${names}`;
    case 'through':
      return `between ${names}`;
    default:
      return `with ${names}`;
  }
}
