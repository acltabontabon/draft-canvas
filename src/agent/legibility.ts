/**
 * How well an arranged diagram *reads* — as opposed to `quality.ts`, which asks whether anything is
 * hidden. A diagram can pass every one of those checks and still be a mess: connectors running the
 * width of the canvas to reach a shape that could have sat beside its caller, a return looping round
 * the outside of everything, lines cutting through boundaries they have nothing to do with, a note
 * stranded far from what it describes. None of that hides content, so none of it is an error — but
 * each is measurable, and what is measured can choose between candidates and be told to the agent.
 *
 * Pure geometry over the connectors exactly as the canvas draws them (`drawnRoute`).
 */

import { visibleEdges } from '../document/compensation';
import { endpointPlan } from '../edges/endpoints';
import type { DraftEdge, DraftNode } from '../document/types';
import { drawnRoute, type Box, type Drawn } from './route';
import { crossingsBetween, isDetour, lengthOf, runsOf } from './routeMetrics';
export { isDetour } from './routeMetrics';

type Point = { x: number; y: number };

export interface Legibility {
  /** Places where two connectors cross (a shared trunk's members never count against each other). */
  crossings: number;
  /** Which connectors cross, a pair each (a trunk by one of its members), so a receipt can say which. */
  crossed: [string, string][];
  /** Connectors drawn far longer than the distance between their ends — around the outside of things. */
  detours: string[];
  /** Connectors that pass through a boundary neither of their ends is in… */
  throughBoundaries: string[];
  /** …and the boundaries they pass through — the ones standing in the way of what runs past them. */
  crossedBoundaries: string[];
  /** Notes further from what they are about than `NOTE_REACH`. */
  farNotes: string[];
  /** Connectors drawn as branches of a shared trunk — parallel lines Smart Routing folded into one. */
  bundled: number;
  /** Total drawn connector length, in pixels. */
  length: number;
  /** Shapes' area over the diagram's bounding area (0–1): low means mostly empty space. */
  fill: number;
  /** Connectors no clear line could be drawn for — through a shape, pinned the wrong way, or walled in. */
  unresolved: string[];
  /** Sides of shapes too short to give every automatic end its own point (`shape:side`). */
  crowded: string[];
}

/** Past this, a note no longer reads as belonging to its subject — and `read.ts`'s `nearestElement`
 *  stops associating the two, so an agent reading the diagram back loses the link too. */
export const NOTE_REACH = 160;

/** Every boundary around `id`, its own included when it is one. */
function ancestry(id: string, byId: Map<string, DraftNode>): Set<string> {
  const out = new Set<string>();
  let at: string | undefined = id;
  while (at && !out.has(at)) {
    out.add(at);
    at = byId.get(at)?.parentId;
  }
  return out;
}

/** Does the orthogonal segment a→b pass into the interior of `box` (not merely along its edge)? */
function entersBox(a: Point, b: Point, box: Box): boolean {
  const inset = 2;
  const x0 = box.x + inset;
  const x1 = box.x + box.width - inset;
  const y0 = box.y + inset;
  const y1 = box.y + box.height - inset;
  if (Math.abs(a.y - b.y) < 1) return a.y > y0 && a.y < y1 && Math.max(a.x, b.x) > x0 && Math.min(a.x, b.x) < x1;
  if (Math.abs(a.x - b.x) < 1) return a.x > x0 && a.x < x1 && Math.max(a.y, b.y) > y0 && Math.min(a.y, b.y) < y1;
  return false;
}

/**
 * The legibility of one view. `about` maps a free note's id to the element it describes, when that is
 * known (a note's subject isn't stored in the file — it's a placement, see `schema.ts`'s note).
 */
export function legibilityOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[], about: ReadonlyMap<string, string> = new Map()): Legibility {
  edges = visibleEdges(edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const drawn: { edge: DraftEdge; route: Drawn }[] = [];
  for (const edge of edges) {
    const route = drawnRoute(edge, nodes, edges, undefined, byId);
    if (route && route.points.length > 1) drawn.push({ edge, route });
  }
  const bundled = drawn.filter((d) => d.route.spine).length;
  // Each route's runs and extent worked out once, not once per pair: two lines whose extents don't
  // meet can't cross, which settles most pairs of a large view with four comparisons.
  const runs = drawn.map(({ route }) => {
    const points = runsOf(route.points);
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const p of points) {
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
    return { points, left, right, top, bottom, spine: route.spine };
  });
  // A trunk is drawn once, however many members run along it: a line across it crosses it in one
  // place, not once per member. Each place is counted once per pair of lines as drawn — a connector
  // or a whole trunk.
  const places = new Set<string>();
  const pairs = new Map<string, [string, string]>();
  for (let i = 0; i < runs.length; i += 1) {
    const a = runs[i]!;
    for (let j = i + 1; j < runs.length; j += 1) {
      const b = runs[j]!;
      if (a.spine && a.spine === b.spine) continue;
      if (a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top) continue;
      const lines = [a.spine ?? `#${i}`, b.spine ?? `#${j}`].sort().join('\u0000');
      for (const p of crossingsBetween(a.points, b.points)) {
        places.add(`${lines}\u0000${Math.round(p.x)}\u0000${Math.round(p.y)}`);
        if (!pairs.has(lines)) pairs.set(lines, [drawn[i]!.edge.id, drawn[j]!.edge.id]);
      }
    }
  }
  const crossings = places.size;
  const groups = nodes.filter((n) => n.type === 'group');
  const detours: string[] = [];
  const throughBoundaries: string[] = [];
  const crossedBoundaries = new Set<string>();
  let length = 0;
  for (const { edge, route } of drawn) {
    const points = route.points;
    const drawnLength = lengthOf(points);
    length += drawnLength;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && target && isDetour(points, source, target)) detours.push(edge.id);
    const own = new Set([...ancestry(edge.source, byId), ...ancestry(edge.target, byId)]);
    const crossed = groups.filter((g) => !own.has(g.id) && points.some((p, k) => k > 0 && entersBox(points[k - 1]!, p, g)));
    if (crossed.length) throughBoundaries.push(edge.id);
    for (const g of crossed) crossedBoundaries.add(g.id);
  }
  const farNotes: string[] = [];
  for (const [noteId, subjectId] of about) {
    const note = byId.get(noteId);
    const subject = byId.get(subjectId);
    if (!note || !subject || note.type !== 'note') continue;
    const dx = Math.max(0, subject.x - (note.x + note.width), note.x - (subject.x + subject.width));
    const dy = Math.max(0, subject.y - (note.y + note.height), note.y - (subject.y + subject.height));
    if (Math.hypot(dx, dy) > NOTE_REACH) farNotes.push(noteId);
  }
  const solid = nodes.filter((n) => n.type !== 'group');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let area = 0;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const n of solid) area += n.width * n.height;
  const bounds = Number.isFinite(minX) ? (maxX - minX) * (maxY - minY) : 0;
  const unresolved = drawn.filter((d) => d.route.status).map((d) => d.edge.id);
  const crowded = [...endpointPlan(nodes, edges, 'transient').crowded];
  return { crossings, crossed: [...pairs.values()], detours, throughBoundaries, crossedBoundaries: [...crossedBoundaries], farNotes, bundled, length: Math.round(length), fill: bounds > 0 ? Math.round((area / bounds) * 1000) / 1000 : 1, unresolved, crowded };
}

/**
 * One number to compare two arrangements' legibility by — lower is better. Only ever consulted between
 * candidates the quality gate already rates the same, so it can never trade hidden content for tidiness.
 */
export function legibilityCost(l: Legibility): number {
  // A trunk's branches count for it: every member is a parallel line the reader no longer follows
  // separately, which is worth the wider gap its captions need.
  return l.crossings * 10 + l.detours.length * 40 + l.throughBoundaries.length * 25 + l.farNotes.length * 30 + l.length / 400 + (1 - l.fill) * 20 - l.bundled * BUNDLE_CREDIT;
}

/** What one connector folded into a shared trunk is worth, against the cost of the room it takes. */
const BUNDLE_CREDIT = 3;
