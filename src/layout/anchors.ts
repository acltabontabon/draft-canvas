/**
 * Which side of each shape a connector leaves and arrives at, decided from where the shapes ended up
 * — the same thing a starter states by hand, so an arranged diagram routes the way an authored one
 * does and the native router, fan-out spines and line jumps take it from there.
 *
 * Only the three handle positions a side really has are used (`0.25`, `0.5`, `0.75`): React Flow
 * resolves a connector's ends through rendered handles, and an offset between them would have no
 * handle to land on.
 */

import type { Side } from '../document/types';
import type { Direction, Rect } from './layered';

export interface AnchorEdge {
  id: string;
  source: string;
  target: string;
  /** Its own words, if any: a labelled connector keeps its own branch and caption. */
  label?: string;
  /** What it means: connectors that mean the same thing from one shape may share one trunk. */
  semantic?: string;
}

export interface Anchors {
  sourceAnchor: { side: Side; offset: number };
  targetAnchor: { side: Side; offset: number };
}

const OFFSETS: Record<number, number[]> = {
  1: [0.5],
  2: [0.25, 0.75],
  3: [0.25, 0.5, 0.75],
};

/** Sides for one connector: along the reading direction when the target lies ahead, across it when
 *  they share a column (or row), and around the outside for one that runs back. */
export function sidesFor(source: Rect, target: Rect, direction: Direction, clearBetween = false): { source: Side; target: Side } {
  if (direction === 'right') {
    if (target.x >= source.x + source.width) return { source: 'right', target: 'left' };
    // A way back with nothing in between (the return half of a two-way pair) runs straight back,
    // beside its forward twin; only one that would cross other shapes goes around the outside.
    if (target.x + target.width <= source.x && clearBetween) return { source: 'left', target: 'right' };
    if (target.x + target.width <= source.x) {
      // Backwards to a shape clearly above or below: an L — out towards it, into the side facing
      // it. Level with each other: a U underneath both.
      if (target.y + target.height < source.y) return { source: 'left', target: 'bottom' };
      if (target.y > source.y + source.height) return { source: 'left', target: 'top' };
      return { source: 'bottom', target: 'bottom' };
    }
    return target.y >= source.y ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' };
  }
  if (target.y >= source.y + source.height) return { source: 'bottom', target: 'top' };
  if (target.y + target.height <= source.y && clearBetween) return { source: 'top', target: 'bottom' };
  if (target.y + target.height <= source.y) {
    if (target.x + target.width < source.x) return { source: 'top', target: 'right' };
    if (target.x > source.x + source.width) return { source: 'top', target: 'left' };
    return { source: 'right', target: 'right' };
  }
  return target.x >= source.x ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' };
}

/** Whether the straight band between two shapes' facing sides — as tall (or wide) as the overlap of
 *  their centre lines, give or take a lane — holds no other shape. */
function corridorClear(source: Rect, target: Rect, rects: Map<string, Rect>, edge: AnchorEdge, direction: Direction): boolean {
  const horizontal = direction === 'right';
  const a = centre(source);
  const b = centre(target);
  const band = horizontal
    ? { x: Math.min(source.x + source.width, target.x + target.width), y: Math.min(a.y, b.y) - 14, width: 0, height: Math.abs(a.y - b.y) + 28 }
    : { x: Math.min(a.x, b.x) - 14, y: Math.min(source.y + source.height, target.y + target.height), width: Math.abs(a.x - b.x) + 28, height: 0 };
  if (horizontal) band.width = Math.max(source.x, target.x) - band.x;
  else band.height = Math.max(source.y, target.y) - band.y;
  if (band.width <= 0 || band.height <= 0) return false;
  for (const [id, r] of rects) {
    if (id === edge.source || id === edge.target) continue;
    // A boundary around either end isn't in the way.
    if ((r.x <= a.x && a.x <= r.x + r.width && r.y <= a.y && a.y <= r.y + r.height) || (r.x <= b.x && b.x <= r.x + r.width && r.y <= b.y && b.y <= r.y + r.height)) continue;
    if (r.x < band.x + band.width && band.x < r.x + r.width && r.y < band.y + band.height && band.y < r.y + r.height) return false;
  }
  // Straight back only between shapes roughly level with each other; far apart ones go around.
  return horizontal ? Math.abs(a.y - b.y) <= Math.max(source.height, target.height) : Math.abs(a.x - b.x) <= Math.max(source.width, target.width);
}

/** A shape's box, and for a queue or Data Store the band its left/right connectors land on. */
export type AnchorRect = Rect & { bandTop?: number; bandBottom?: number };

const HANDLES = [0.25, 0.5, 0.75];
/** How long a side must be for two opposite connectors at 0.25 and 0.75 to keep their captions apart. */
const TWIN_SPAN = 60;

function spanOf(rect: AnchorRect, direction: Direction): number {
  if (direction === 'down') return rect.width;
  return rect.bandTop !== undefined && rect.bandBottom !== undefined ? rect.bandBottom - rect.bandTop : rect.height;
}
/** How much straighter a line must get before a lone connector leaves the middle of its side. */
const CENTRE_PREFERENCE = 6;

/**
 * Handle positions for `others.length` connectors on one side (already in order), chosen from the
 * three the side has so that each lines up as nearly as it can with the middle of what it connects
 * to — a level neighbour then gets a straight line, not a jog of a few pixels the router would hang
 * a caption on. Order is kept, so connectors still never cross on the way out.
 */
function alignedOffsets(own: AnchorRect, side: Side, others: Rect[]): number[] | undefined {
  const horizontal = side === 'top' || side === 'bottom';
  const start = horizontal ? own.x : (own.bandTop ?? own.y);
  const span = horizontal ? own.width : (own.bandBottom ?? own.y + own.height) - start;
  const at = (offset: number) => start + offset * span;
  const target = (r: AnchorRect) => (horizontal ? r.x + r.width / 2 : r.bandTop !== undefined && r.bandBottom !== undefined ? (r.bandTop + r.bandBottom) / 2 : r.y + r.height / 2);
  const n = others.length;
  let best: number[] | undefined;
  let bestCost = Infinity;
  const choose = (from: number, picked: number[]) => {
    if (picked.length === n) {
      const cost = picked.reduce((sum, offset, i) => sum + Math.abs(target(others[i] as AnchorRect) - at(offset)), 0) + (n === 1 && picked[0] !== 0.5 ? CENTRE_PREFERENCE : 0);
      if (cost < bestCost - 0.01) {
        bestCost = cost;
        best = [...picked];
      }
      return;
    }
    for (let i = from; i < HANDLES.length; i += 1) choose(i + 1, [...picked, HANDLES[i] as number]);
  };
  choose(0, []);
  return best;
}

function centre(rect: Rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Anchors for every edge. Connectors sharing one side of a shape spread over its handles in the
 * order of where their other ends are, so they don't cross each other on the way out; more than
 * three share the nearest handle and the native spine bundles them.
 *
 * `pinned` names edges whose side and offset are already decided (an untouched neighbour a scoped
 * re-anchor must route around, not recompute) — they keep exactly the anchor given, are never moved
 * to another side by the overflow rule below, and still occupy their slot so a free edge on the same
 * side is placed clear of them. When a side holds any pinned edge, the free edges sharing it are
 * spread over whatever handles remain, in order, rather than run through the optimal-alignment
 * search below — correctness (never landing on an occupied handle) matters more than optimal
 * alignment for a side an unrelated connector already has a fixed claim on.
 */
export function assignAnchors(edges: AnchorEdge[], rects: Map<string, Rect>, direction: Direction, pinned?: ReadonlyMap<string, Anchors>): Map<string, Anchors> {
  const sides = new Map<string, { source: Side; target: Side }>();
  const onSide = new Map<string, { edge: string; end: 'source' | 'target'; other: Rect; pinnedOffset?: number }[]>();
  for (const edge of edges) {
    const s = rects.get(edge.source);
    const t = rects.get(edge.target);
    if (!s || !t) continue;
    const fixed = pinned?.get(edge.id);
    // The way back of a pair drawn both ways: straight back beside its twin when both shapes are tall
    // enough for the two to sit a caption's height apart (0.25 and 0.75 of the side); between small
    // shapes (a queue's tube) they would run a few pixels apart, so it goes around instead.
    const twin = edges.some((other) => other !== edge && other.source === edge.target && other.target === edge.source);
    const roomy = Math.min(spanOf(s, direction), spanOf(t, direction)) >= TWIN_SPAN;
    const chosen = fixed ? { source: fixed.sourceAnchor.side, target: fixed.targetAnchor.side } : sidesFor(s, t, direction, (!twin || roomy) && corridorClear(s, t, rects, edge, direction));
    sides.set(edge.id, chosen);
    for (const [end, node, side, other, offset] of [
      ['source', edge.source, chosen.source, t, fixed?.sourceAnchor.offset],
      ['target', edge.target, chosen.target, s, fixed?.targetAnchor.offset],
    ] as const) {
      const key = `${node}\u0000${side}`;
      const list = onSide.get(key) ?? [];
      list.push({ edge: edge.id, end, other, ...(offset !== undefined ? { pinnedOffset: offset } : {}) });
      onSide.set(key, list);
    }
  }
  // A side has three handles. Past three connectors, the ones reaching furthest up or down leave by
  // the top or bottom instead of sharing a handle (and a line) with a neighbour. A pinned entry never
  // moves — it isn't this scoped re-anchor's to relocate.
  for (const [key, list] of [...onSide]) {
    const side = key.slice(key.indexOf('\u0000') + 1) as Side;
    if (list.length <= 3 || (side !== 'left' && side !== 'right')) continue;
    const node = key.slice(0, key.indexOf('\u0000'));
    const own = rects.get(node);
    if (!own) continue;
    list.sort((a, b) => centre(a.other).y - centre(b.other).y || (a.edge < b.edge ? -1 : 1));
    const moves: { entry: (typeof list)[number]; to: Side }[] = [];
    const movable = (entry: (typeof list)[number] | undefined) => entry && entry.pinnedOffset === undefined;
    while (list.length - moves.length > 3) {
      const first = list[moves.filter((m) => m.to === 'top').length];
      const last = list[list.length - 1 - moves.filter((m) => m.to === 'bottom').length];
      const up = movable(first) && centre((first as (typeof list)[number]).other).y < own.y ? first : undefined;
      const down = movable(last) && centre((last as (typeof list)[number]).other).y > own.y + own.height ? last : undefined;
      const pick = up && (!down || own.y - centre(up.other).y >= centre((down as (typeof list)[number]).other).y - (own.y + own.height)) ? { entry: up, to: 'top' as Side } : down ? { entry: down, to: 'bottom' as Side } : undefined;
      if (!pick) break;
      moves.push(pick);
    }
    for (const { entry, to } of moves) {
      list.splice(list.indexOf(entry), 1);
      const chosen = sides.get(entry.edge);
      if (chosen) sides.set(entry.edge, entry.end === 'source' ? { ...chosen, source: to } : { ...chosen, target: to });
      const moved = `${node}\u0000${to}`;
      onSide.set(moved, [...(onSide.get(moved) ?? []), entry]);
    }
  }
  const offsets = new Map<string, number>();
  const byId = new Map(edges.map((e) => [e.id, e]));
  for (const [key, list] of onSide) {
    const pinnedEntries = list.filter((e) => e.pinnedOffset !== undefined);
    for (const entry of pinnedEntries) offsets.set(`${entry.edge}\u0000${entry.end}`, entry.pinnedOffset as number);
    const free = list.filter((e) => e.pinnedOffset === undefined);
    if (!free.length) continue;
    if (pinnedEntries.length) {
      // A side an unrelated connector already occupies: fill whatever handles remain, in the order
      // the free ends already sit in, rather than search for the alignment the unconstrained case
      // below would — the taken handle rules that search out.
      const available = HANDLES.filter((h) => !pinnedEntries.some((e) => e.pinnedOffset === h));
      const horizontal = (key.slice(key.indexOf('\u0000') + 1) as Side) === 'top' || (key.slice(key.indexOf('\u0000') + 1) as Side) === 'bottom';
      free.sort((a, b) => {
        const ca = centre(a.other);
        const cb = centre(b.other);
        return (horizontal ? ca.x - cb.x : ca.y - cb.y) || (a.edge < b.edge ? -1 : 1);
      });
      free.forEach((entry, i) => offsets.set(`${entry.edge}\u0000${entry.end}`, available[Math.min(i, available.length - 1)] ?? 0.5));
      continue;
    }
    // A fan (or funnel) of unlabelled connectors that all mean the same thing — a topic fanning out to
    // its queues — leaves from one point, so the native router draws them as one trunk with one caption
    // ("fans out to", once) instead of parallel lines each repeating it. Words of their own, or
    // different meanings, keep each connector on its own handle.
    const members = free.map((entry) => byId.get(entry.edge));
    const fan =
      free.length >= 2 &&
      new Set(free.map((entry) => entry.end)).size === 1 &&
      new Set(free.map((entry) => entry.other)).size === free.length &&
      members.every((m) => m && !m.label && m.semantic && m.semantic === members[0]?.semantic);
    if (fan) {
      for (const entry of free) offsets.set(`${entry.edge}\u0000${entry.end}`, 0.5);
      continue;
    }
    const side = key.slice(key.indexOf('\u0000') + 1) as Side;
    const horizontal = side === 'top' || side === 'bottom';
    free.sort((a, b) => {
      const ca = centre(a.other);
      const cb = centre(b.other);
      return (horizontal ? ca.x - cb.x : ca.y - cb.y) || (a.edge < b.edge ? -1 : 1);
    });
    const n = free.length;
    const node = key.slice(0, key.indexOf('\u0000'));
    const own = rects.get(node);
    // Connectors to the same shape (a compensation twin) stay spread over the side: aligned on one
    // shared target they would land a few pixels apart, and so would their captions.
    const twins = new Set(free.map((e) => e.other)).size < free.length;
    const chosen = own && n <= 3 && !twins ? alignedOffsets(own, side, free.map((e) => e.other)) : undefined;
    free.forEach((entry, i) => {
      const offset = chosen?.[i] ?? (n <= 3 ? OFFSETS[n]?.[i] : OFFSETS[3]?.[Math.min(2, Math.floor((i * 3) / n))]) ?? 0.5;
      offsets.set(`${entry.edge}\u0000${entry.end}`, offset);
    });
  }
  const out = new Map<string, Anchors>();
  for (const edge of edges) {
    const chosen = sides.get(edge.id);
    if (!chosen) continue;
    out.set(edge.id, {
      sourceAnchor: { side: chosen.source, offset: offsets.get(`${edge.id}\u0000source`) ?? 0.5 },
      targetAnchor: { side: chosen.target, offset: offsets.get(`${edge.id}\u0000target`) ?? 0.5 },
    });
  }
  return out;
}
