/**
 * Which side of each shape a connector leaves and arrives at, decided from where the shapes ended up
 * — the same thing a starter states by hand, so an arranged diagram routes the way an authored one
 * does and the native router, fan-out spines and line jumps take it from there.
 *
 * Only the three handle positions a side really has are used (`0.25`, `0.5`, `0.75`): React Flow
 * resolves a connector's ends through rendered handles, and an offset between them would have no
 * handle to land on.
 */

import type { DraftEdge, Side } from '../document/types';
import { compatibilityKey, MIN_FAN_SPREAD } from '../edges/bundles';
import type { Direction, Rect } from './layered';

export interface AnchorEdge extends Pick<DraftEdge, 'kind' | 'directed' | 'async' | 'hasResponse' | 'accent' | 'deliveryAttempts' | 'semantic'> {
  id: string;
  source: string;
  target: string;
  /** Its own words, if any: a labelled connector keeps its own branch and caption — on a shared trunk
   *  when enough of them mean the same thing (see `assignAnchors`'s labelled fan). */
  label?: string;
}

export interface AnchorOptions {
  /** Connectors that never join a labelled fan — the main path, which stays its own straight line. */
  keepApart?: ReadonlySet<string>;
  /** Sides the layout already chose for a connector it ran across the flow (`LayoutOutput.sides`):
   *  used as they are, where `sidesFor` would read the geometry as a forward step and round a corner. */
  sides?: ReadonlyMap<string, { source: Side; target: Side }>;
  /** `unlabelled` (the repair's fallback) never bundles labelled connectors; `unshared` bundles them
   *  only on a side of their own, as it did before a fan could share one. Default `all`. */
  fans?: 'all' | 'unshared' | 'unlabelled';
}

/** Labelled connectors that share a trunk each keep a caption on their branch: fewer than this and two
 *  separate lines read as well, with no bends. */
export const MIN_LABELLED_FAN = 3;

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
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
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
 * Between two connectors whose far ends sit level along a side (two shapes in one column, both
 * reached out of the top of a shape beside them), which takes the handle first: the one that turns
 * furthest out, so each line's corner sits outside the next one's and the two nest instead of
 * crossing. Zero when the far ends aren't to one side of `own`.
 */
function nesting(own: Rect, side: Side, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const mid = centre(own);
  if (side === 'top' || side === 'bottom') {
    if (a.x === mid.x) return 0;
    // Out of the top towards the right: the handle furthest left goes highest.
    return (side === 'top' ? 1 : -1) * (a.x > mid.x ? 1 : -1) * (a.y - b.y);
  }
  if (a.y === mid.y) return 0;
  // Out of the right side downwards: the handle highest up goes furthest right.
  return (side === 'left' ? 1 : -1) * (a.y > mid.y ? 1 : -1) * (a.x - b.x);
}

interface SideEntry {
  edge: string;
  end: 'source' | 'target';
  other: Rect;
}

/** Where along `side` of `own` a handle sits, on the axis across it (y for left/right). */
function handleAt(own: AnchorRect, side: Side, offset: number): number {
  if (side === 'top' || side === 'bottom') return own.x + offset * own.width;
  const start = own.bandTop ?? own.y;
  return start + offset * ((own.bandBottom ?? own.y + own.height) - start);
}

/**
 * Handles for a side shared by a labelled fan (`fanOf`) and other connectors: the fan's members leave
 * by one handle, as one trunk, and the others keep their own, in order, each lined up as nearly as it
 * can be with where it leads. The fan's stem only reaches its trunk, so it takes whichever handle is
 * left — but never one between another connector's handle and where that one turns towards, where
 * the turn would cross the stem. Undefined when the side holds no fan, or more than its three handles'
 * worth.
 */
function sharedFanHandles(own: AnchorRect, side: Side, entries: SideEntry[], fanOf: ReadonlyMap<string, string>): Map<SideEntry, number> | undefined {
  const units = new Map<string, SideEntry[]>();
  for (const entry of entries) {
    const unit = fanOf.get(`${entry.edge}\u0000${entry.end}`) ?? `${entry.edge}\u0000${entry.end}`;
    units.set(unit, [...(units.get(unit) ?? []), entry]);
  }
  if (units.size === entries.length || units.size > 3) return undefined;
  const horizontal = side === 'top' || side === 'bottom';
  const across = (r: Rect) => (horizontal ? centre(r).x : centre(r).y);
  const middle = (list: SideEntry[]) => list.reduce((sum, e) => sum + across(e.other), 0) / list.length;
  const ordered = [...units.values()].sort((a, b) => middle(a) - middle(b) || (a[0]!.edge < b[0]!.edge ? -1 : 1));
  let best: number[] | undefined;
  let bestCost = Infinity;
  const pick = (used: number[]) => {
    if (used.length === ordered.length) {
      const at = used.map((h) => handleAt(own, side, h));
      const loners = ordered.map((list, i) => ({ list, i })).filter(({ list }) => list.length === 1);
      for (let k = 1; k < loners.length; k += 1) if ((at[loners[k]!.i] as number) < (at[loners[k - 1]!.i] as number)) return;
      let cost = 0;
      ordered.forEach((list, i) => {
        const y = at[i] as number;
        if (list.length === 1) {
          cost += Math.abs(y - across(list[0]!.other));
          return;
        }
        // The stem's own place barely matters; its middle breaks a tie.
        cost += Math.abs(y - middle(list)) / 100;
        for (const { list: other, i: j } of loners) {
          const from = at[j] as number;
          const to = across(other[0]!.other);
          if (y > Math.min(from, to) && y < Math.max(from, to)) cost += ARRIVAL_CROSSING;
        }
      });
      if (cost < bestCost - 0.001) {
        bestCost = cost;
        best = [...used];
      }
      return;
    }
    for (const h of HANDLES) if (!used.includes(h)) pick([...used, h]);
  };
  pick([]);
  if (!best) return undefined;
  const out = new Map<SideEntry, number>();
  ordered.forEach((list, i) => {
    for (const entry of list) out.set(entry, best![i] as number);
  });
  return out;
}

/** Room a trunk's branch keeps from a shape it runs past (`edges/bundles.ts`'s `TRUNK_OBSTACLE_MARGIN`). */
const BRANCH_CLEARANCE = 20;
/** What a branch arriving through a shape costs, against pixels of misalignment: never worth it. */
const BLOCKED_BRANCH = 1000;
/** What a crossing at the arrival costs, against pixels of misalignment. */
const ARRIVAL_CROSSING = 500;

/** Whether a trunk's branch from `hub`, arriving at `side` of `own` at `at` across the flow, runs
 *  straight back towards the hub clear of every other shape. */
function branchClear(own: Rect, side: Side, hub: Rect, at: number, rects: ReadonlyMap<string, Rect>): boolean {
  const horizontal = side === 'top' || side === 'bottom';
  // The run from the hub's facing side to this one.
  const [lo, hi] = horizontal
    ? [Math.min(hub.y + hub.height, own.y + own.height), Math.max(hub.y, own.y)]
    : [Math.min(hub.x + hub.width, own.x + own.width), Math.max(hub.x, own.x)];
  for (const r of rects.values()) {
    if (r === hub || r === own) continue;
    const [rLo, rHi, cLo, cHi] = horizontal ? [r.y, r.y + r.height, r.x, r.x + r.width] : [r.x, r.x + r.width, r.y, r.y + r.height];
    if (rHi > lo && rLo < hi && cHi > at - BRANCH_CLEARANCE && cLo < at + BRANCH_CLEARANCE) return false;
  }
  return true;
}

/**
 * Handles for a side where branches of a trunk arrive (`branchEnds`, by entry, holds the hub each one
 * comes from). A branch runs straight off the trunk at its handle's height, so it takes a handle whose
 * straight run back towards the hub clears every other shape — and one that doesn't sit between
 * another connector arriving on this side and where that connector comes from, where its last bend
 * would cross the branch. The other connectors line up with where they come from, as `alignedOffsets`
 * has them, in order.
 */
function branchHandles(own: AnchorRect, side: Side, entries: SideEntry[], branchEnds: ReadonlyMap<string, Rect>, rects: ReadonlyMap<string, Rect>): Map<SideEntry, number> | undefined {
  const horizontal = side === 'top' || side === 'bottom';
  const across = (r: Rect) => (horizontal ? centre(r).x : centre(r).y);
  const hubOf = (e: SideEntry) => branchEnds.get(`${e.edge}\u0000${e.end}`);
  const clear = (hub: Rect, at: number) => branchClear(own, side, hub, at, rects);
  let best: Map<SideEntry, number> | undefined;
  let bestCost = Infinity;
  const pick = (i: number, used: number[]) => {
    if (i === entries.length) {
      let cost = 0;
      const placed = entries.map((e, k) => ({ e, at: handleAt(own, side, used[k] as number), hub: hubOf(e) }));
      const direct = placed.filter((p) => !p.hub);
      // The other connectors keep their order along the side, so they never cross each other.
      for (let k = 1; k < direct.length; k += 1) if ((direct[k] as (typeof direct)[number]).at < (direct[k - 1] as (typeof direct)[number]).at) return;
      placed.forEach((p, k) => {
        // A branch is straight at any handle; only the others have somewhere to line up with.
        cost += (p.hub ? 0 : Math.abs(p.at - across(p.e.other))) + (used[k] === 0.5 ? 0 : CENTRE_PREFERENCE);
        if (p.hub && !clear(p.hub, p.at)) cost += BLOCKED_BRANCH;
      });
      // A connector arriving from nearer by turns towards its handle in front of a branch from
      // further off (a direct one in the last gap, another trunk on its own trunk line): the branch
      // must not arrive between that turn's two ends.
      const distance = (r: Rect) => (horizontal ? Math.abs(centre(r).y - centre(own).y) : Math.abs(centre(r).x - centre(own).x));
      for (const branch of placed.filter((p) => p.hub)) {
        for (const near of placed) {
          if (near === branch || (near.hub && distance(near.hub) >= distance(branch.hub as Rect))) continue;
          const from = across(near.hub ?? near.e.other);
          if (branch.at > Math.min(from, near.at) && branch.at < Math.max(from, near.at)) cost += ARRIVAL_CROSSING;
        }
      }
      if (cost < bestCost - 0.01) {
        bestCost = cost;
        best = new Map(entries.map((e, k) => [e, used[k] as number]));
      }
      return;
    }
    for (const h of HANDLES) if (!used.includes(h)) pick(i + 1, [...used, h]);
  };
  pick(0, []);
  return best;
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
export function assignAnchors(
  edges: AnchorEdge[],
  rects: Map<string, Rect>,
  direction: Direction,
  pinned?: ReadonlyMap<string, Anchors>,
  /** A side of a shape no connector may use — where a note about it sits. */
  reserved?: ReadonlyMap<string, Side>,
  options: AnchorOptions = {},
): Map<string, Anchors> {
  const sides = new Map<string, { source: Side; target: Side }>();
  const onSide = new Map<string, { edge: string; end: 'source' | 'target'; other: Rect; pinnedOffset?: number }[]>();
  // Which ordered pairs have a connector, once, so finding a twin is a lookup rather than a scan.
  const pairs = new Map<string, number>();
  for (const edge of edges) pairs.set(`${edge.source}\u0000${edge.target}`, (pairs.get(`${edge.source}\u0000${edge.target}`) ?? 0) + 1);
  for (const edge of edges) {
    const s = rects.get(edge.source);
    const t = rects.get(edge.target);
    if (!s || !t) continue;
    const fixed = pinned?.get(edge.id);
    // The way back of a pair drawn both ways: straight back beside its twin when both shapes are tall
    // enough for the two to sit a caption's height apart (0.25 and 0.75 of the side); between small
    // shapes (a queue's tube) they would run a few pixels apart, so it goes around instead.
    // A self-loop is its own reverse, so it needs a second loop to have a twin.
    const reverse = pairs.get(`${edge.target}\u0000${edge.source}`) ?? 0;
    const twin = edge.source === edge.target ? reverse > 1 : reverse > 0;
    const roomy = Math.min(spanOf(s, direction), spanOf(t, direction)) >= TWIN_SPAN;
    const free = fixed ? { source: fixed.sourceAnchor.side, target: fixed.targetAnchor.side } : (options.sides?.get(edge.id) ?? sidesFor(s, t, direction, (!twin || roomy) && corridorClear(s, t, rects, edge, direction)));
    // A reserved side gives way to the one the reading direction leaves (or arrives) by.
    const chosen = fixed
      ? free
      : {
          source: reserved?.get(edge.source) === free.source ? (direction === 'right' ? 'right' : 'bottom') : free.source,
          target: reserved?.get(edge.target) === free.target ? (direction === 'right' ? 'left' : 'top') : free.target,
        };
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
  const byId = new Map(edges.map((e) => [e.id, e]));
  // Labelled connectors out of (or into) one shape that mean the same thing share a trunk even on a
  // side other connectors use too — a frontend calling six services the same way, beside its main
  // path and one call of another kind. The fan takes one handle; the others keep theirs.
  const fanOf = new Map<string, string>();
  if (options.fans !== 'unlabelled' && options.fans !== 'unshared') {
    for (const [key, list] of onSide) {
      const side = key.slice(key.indexOf('\u0000') + 1) as Side;
      const horizontal = side === 'top' || side === 'bottom';
      const groups = new Map<string, (typeof list)[number][]>();
      for (const entry of list) {
        const edge = byId.get(entry.edge);
        if (!edge?.label || entry.pinnedOffset !== undefined) continue;
        // The main path's own steps fan out together (an orchestrator calling one thing after
        // another), never with other connectors: it stays a line of its own beside them.
        const group = `${entry.end}\u0000${compatibilityKey(edge)}\u0000${options.keepApart?.has(edge.id) ? 'main' : ''}`;
        groups.set(group, [...(groups.get(group) ?? []), entry]);
      }
      for (const [group, members] of groups) {
        if (members.length < MIN_LABELLED_FAN || new Set(members.map((m) => m.other)).size < members.length) continue;
        const across = members.map((m) => (horizontal ? centre(m.other).x : centre(m.other).y));
        if (Math.max(...across) - Math.min(...across) < MIN_FAN_SPREAD) continue;
        // The router's own gates (`edges/bundles.ts`): every branch arrives on the side facing the hub,
        // and runs straight to it at one of that side's handles. A shared handle that ends in no trunk
        // is several lines drawn on top of each other.
        const hub = rects.get(key.slice(0, key.indexOf('\u0000')));
        const reaches = (m: (typeof members)[number]) => {
          const far = sides.get(m.edge)?.[m.end === 'source' ? 'target' : 'source'];
          return hub && far === OPPOSITE[side] && HANDLES.some((h) => branchClear(m.other, far, hub, handleAt(m.other, far, h), rects));
        };
        if (!members.every(reaches)) continue;
        for (const m of members) fanOf.set(`${m.edge}\u0000${m.end}`, `${key}\u0000${group}`);
      }
    }
  }
  const unitsOn = (list: { edge: string; end: 'source' | 'target' }[]) => new Set(list.map((e) => fanOf.get(`${e.edge}\u0000${e.end}`) ?? `${e.edge}\u0000${e.end}`)).size;
  // A side has three handles. Past three connectors, the ones reaching furthest up or down leave by
  // the top or bottom instead of sharing a handle (and a line) with a neighbour. A pinned entry never
  // moves — it isn't this scoped re-anchor's to relocate, and neither does a fan's member: the fan
  // leaves by one handle.
  for (const [key, list] of [...onSide]) {
    const side = key.slice(key.indexOf('\u0000') + 1) as Side;
    if (unitsOn(list) <= 3 || (side !== 'left' && side !== 'right')) continue;
    const node = key.slice(0, key.indexOf('\u0000'));
    const own = rects.get(node);
    if (!own) continue;
    list.sort((a, b) => centre(a.other).y - centre(b.other).y || (a.edge < b.edge ? -1 : 1));
    const moves: { entry: (typeof list)[number]; to: Side }[] = [];
    // The candidates to move, outermost first: a fan's members stay with their trunk.
    const loose = list.filter((entry) => !fanOf.has(`${entry.edge}\u0000${entry.end}`));
    const units = unitsOn(list);
    const movable = (entry: (typeof list)[number] | undefined) => entry && entry.pinnedOffset === undefined;
    while (units - moves.length > 3) {
      const first = loose[moves.filter((m) => m.to === 'top').length];
      const last = loose[loose.length - 1 - moves.filter((m) => m.to === 'bottom').length];
      if (!first || !last || moves.some((m) => m.entry === first || m.entry === last)) break;
      // Only out of a side with room to leave by: a shape right beside it in its own column would
      // take the line straight through it.
      const open = (entry: (typeof list)[number], to: number) =>
        ![...rects.values()].some((r) => r !== own && r !== entry.other && r.x < own.x + own.width && r.x + r.width > own.x && r.y < Math.max(own.y, to) && r.y + r.height > Math.min(own.y + own.height, to));
      const up = movable(first) && reserved?.get(node) !== 'top' && centre((first as (typeof list)[number]).other).y < own.y && open(first as (typeof list)[number], centre((first as (typeof list)[number]).other).y) ? first : undefined;
      const down = movable(last) && reserved?.get(node) !== 'bottom' && centre((last as (typeof list)[number]).other).y > own.y + own.height && open(last as (typeof list)[number], centre((last as (typeof list)[number]).other).y) ? last : undefined;
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
  // The far end of every fan member: its branch runs straight off the trunk into that end, so that
  // end picks a handle the branch can reach (see `branchHandles`).
  const branchEnds = new Map<string, Rect>();
  for (const [entryKey] of fanOf) {
    const [edge, end] = entryKey.split('\u0000') as [string, 'source' | 'target'];
    const hub = rects.get(end === 'source' ? (byId.get(edge)?.source ?? '') : (byId.get(edge)?.target ?? ''));
    if (hub) branchEnds.set(`${edge}\u0000${end === 'source' ? 'target' : 'source'}`, hub);
  }
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
    const oneEnd = new Set(free.map((entry) => entry.end)).size === 1 && new Set(free.map((entry) => entry.other)).size === free.length;
    const fan = free.length >= 2 && oneEnd && members.every((m) => m && !m.label && m.semantic && m.semantic === members[0]?.semantic);
    const side = key.slice(key.indexOf('\u0000') + 1) as Side;
    const horizontal = side === 'top' || side === 'bottom';
    // Labelled connectors bundle too, when enough of them leave one shape meaning the same thing and
    // reach shapes spread across the flow — every branch then carries its own words after the shared
    // stem, in the room the layout keeps for it — but never the main path, and never a fan the
    // router would refuse anyway (`edges/bundles.ts`'s gates, checked here so a shared point that
    // ends in no trunk isn't three lines drawn on top of each other).
    const labelledFan =
      options.fans !== 'unlabelled' &&
      free.length >= MIN_LABELLED_FAN &&
      oneEnd &&
      members.every((m) => m && m.label && compatibilityKey(m) === compatibilityKey(members[0] as AnchorEdge) && !!options.keepApart?.has(m.id) === !!options.keepApart?.has((members[0] as AnchorEdge).id)) &&
      Math.max(...free.map((e) => (horizontal ? centre(e.other).x : centre(e.other).y))) - Math.min(...free.map((e) => (horizontal ? centre(e.other).x : centre(e.other).y))) >= MIN_FAN_SPREAD;
    if (fan || labelledFan) {
      for (const entry of free) offsets.set(`${entry.edge}\u0000${entry.end}`, 0.5);
      continue;
    }
    const node = key.slice(0, key.indexOf('\u0000'));
    const own = rects.get(node);
    free.sort((a, b) => {
      const ca = centre(a.other);
      const cb = centre(b.other);
      return (horizontal ? ca.x - cb.x : ca.y - cb.y) || (own ? nesting(own, side, ca, cb) : 0) || (a.edge < b.edge ? -1 : 1);
    });
    const n = free.length;
    const shared = own && sharedFanHandles(own, side, free, fanOf);
    if (shared) {
      for (const [entry, offset] of shared) offsets.set(`${entry.edge}\u0000${entry.end}`, offset);
      continue;
    }
    const branches = own && n <= 3 && free.some((e) => branchEnds.has(`${e.edge}\u0000${e.end}`)) ? branchHandles(own, side, free, branchEnds, rects) : undefined;
    if (branches) {
      for (const [entry, offset] of branches) offsets.set(`${entry.edge}\u0000${entry.end}`, offset);
      continue;
    }
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
