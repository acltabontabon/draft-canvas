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

import type { DraftEdge, DraftNode } from '../document/types';
import { drawnRoute, type Box, type Drawn } from './route';

type Point = { x: number; y: number };

export interface Legibility {
  /** Places where two connectors cross (a shared trunk's members never count against each other). */
  crossings: number;
  /** Connectors drawn far longer than the distance between their ends — around the outside of things. */
  detours: string[];
  /** Connectors that pass through a boundary neither of their ends is in. */
  throughBoundaries: string[];
  /** Notes further from what they are about than `NOTE_REACH`. */
  farNotes: string[];
  /** Total drawn connector length, in pixels. */
  length: number;
  /** Shapes' area over the diagram's bounding area (0–1): low means mostly empty space. */
  fill: number;
}

/** Past this, a note no longer reads as belonging to its subject — and `read.ts`'s `nearestElement`
 *  stops associating the two, so an agent reading the diagram back loses the link too. */
export const NOTE_REACH = 160;
/** A connector counts as a detour when it is longer than this many times the distance between the
 *  middles of the two shapes it joins… */
const DETOUR_RATIO = 1.5;
/** …plus this much, so a short hop round a corner (or out of a side facing away) doesn't count. */
const DETOUR_EXTRA = 200;

/** Whether a route drawn as `points` goes the long way round between the shapes it joins. */
export function isDetour(points: readonly Point[], source: Box, target: Box): boolean {
  const direct = Math.abs(source.x + source.width / 2 - (target.x + target.width / 2)) + Math.abs(source.y + source.height / 2 - (target.y + target.height / 2));
  return lengthOf(points) > direct * DETOUR_RATIO + DETOUR_EXTRA;
}

const lengthOf = (points: readonly Point[]) => points.reduce((sum, p, i) => (i ? sum + Math.abs(p.x - points[i - 1]!.x) + Math.abs(p.y - points[i - 1]!.y) : 0), 0);

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

/** A route as its runs: zero-length steps dropped and straight stretches merged. The router splits
 *  a straight line at its midpoint, which is exactly where another connector tends to cross it. */
function runsOf(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    const before = out[out.length - 2];
    if (last && before && ((Math.abs(before.x - last.x) < 0.5 && Math.abs(last.x - p.x) < 0.5) || (Math.abs(before.y - last.y) < 0.5 && Math.abs(last.y - p.y) < 0.5))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Proper crossings between two orthogonal polylines: a horizontal run of one through a vertical run
 *  of the other, away from either's ends (two connectors leaving one handle don't "cross"). */
function crossingsBetween(a: readonly Point[], b: readonly Point[]): number {
  let count = 0;
  const margin = 4;
  for (let i = 1; i < a.length; i += 1) {
    const [a0, a1] = [a[i - 1]!, a[i]!];
    for (let j = 1; j < b.length; j += 1) {
      const [b0, b1] = [b[j - 1]!, b[j]!];
      const [h0, h1, v0, v1] = Math.abs(a0.y - a1.y) < 1 && Math.abs(b0.x - b1.x) < 1 ? [a0, a1, b0, b1] : Math.abs(b0.y - b1.y) < 1 && Math.abs(a0.x - a1.x) < 1 ? [b0, b1, a0, a1] : [];
      if (!h0 || !h1 || !v0 || !v1) continue;
      const x = v0.x;
      const y = h0.y;
      if (x > Math.min(h0.x, h1.x) + margin && x < Math.max(h0.x, h1.x) - margin && y > Math.min(v0.y, v1.y) + margin && y < Math.max(v0.y, v1.y) - margin) count += 1;
    }
  }
  return count;
}

/**
 * The legibility of one view. `about` maps a free note's id to the element it describes, when that is
 * known (a note's subject isn't stored in the file — it's a placement, see `schema.ts`'s note).
 */
export function legibilityOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[], about: ReadonlyMap<string, string> = new Map()): Legibility {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const drawn: { edge: DraftEdge; route: Drawn }[] = [];
  for (const edge of edges) {
    const route = drawnRoute(edge, nodes, edges);
    if (route && route.points.length > 1) drawn.push({ edge, route });
  }
  let crossings = 0;
  for (let i = 0; i < drawn.length; i += 1) {
    for (let j = i + 1; j < drawn.length; j += 1) {
      const a = drawn[i]!;
      const b = drawn[j]!;
      if (a.route.spine && a.route.spine === b.route.spine) continue;
      crossings += crossingsBetween(runsOf(a.route.points), runsOf(b.route.points));
    }
  }
  const groups = nodes.filter((n) => n.type === 'group');
  const detours: string[] = [];
  const throughBoundaries: string[] = [];
  let length = 0;
  for (const { edge, route } of drawn) {
    const points = route.points;
    const drawnLength = lengthOf(points);
    length += drawnLength;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && target && isDetour(points, source, target)) detours.push(edge.id);
    const own = new Set([...ancestry(edge.source, byId), ...ancestry(edge.target, byId)]);
    if (groups.some((g) => !own.has(g.id) && points.some((p, k) => k > 0 && entersBox(points[k - 1]!, p, g)))) throughBoundaries.push(edge.id);
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
  return { crossings, detours, throughBoundaries, farNotes, length: Math.round(length), fill: bounds > 0 ? Math.round((area / bounds) * 1000) / 1000 : 1 };
}

/**
 * One number to compare two arrangements' legibility by — lower is better. Only ever consulted between
 * candidates the quality gate already rates the same, so it can never trade hidden content for tidiness.
 */
export function legibilityCost(l: Legibility): number {
  return l.crossings * 10 + l.detours.length * 40 + l.throughBoundaries.length * 25 + l.farNotes.length * 30 + l.length / 400 + (1 - l.fill) * 20;
}
