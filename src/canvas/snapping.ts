import type { Rect } from '../edges/routing';

/**
 * Alignment snapping.
 *
 * The brief this tool is built against is that a user should almost never reach
 * for an "align" command, because dragging already lands things in the right
 * place. In order of strength, a dragged shape snaps to:
 *
 * 1. where a connector to it runs perfectly straight (`links`) — the line through
 *    each shape's anchor axis, which for a queue or Data Store is the middle of its
 *    tube or glyph rather than of its box. Of everything here this does the most
 *    for how a diagram looks, so it catches from further away and beats the rest;
 * 2. the edges and centres of its neighbours; and
 * 3. an even spacing with them (`spacing`): the gap it leaves to a neighbour in its
 *    row or column matches one already there, or it sits centred between two.
 *
 * Only the closest candidate per axis wins (after strength), so a node cannot be
 * pulled two ways at once.
 */

/** How close, in screen pixels, before an edge, centre or spacing candidate takes hold. */
export const SNAP_THRESHOLD = 6;

/** How close, in screen pixels, before a connector's straight line takes hold: twice the reach of
 *  the rest. */
export const CONNECTOR_SNAP_THRESHOLD = 12;

/** What `computeSnap` and `snapResize` are handed at a zoom: the same reach on screen at every zoom,
 *  which is a different number of canvas units. */
export interface SnapReach {
  /** Edges, centres and spacing, in canvas units. */
  threshold: number;
  /** A connector's straight line, in canvas units. */
  connectorThreshold: number;
}

/**
 * The snap thresholds for a zoom. They are measured on screen — a person aims with a pointer, not
 * with canvas units — so at zoom 4 a shape catches within 1.5 units, and at zoom 0.25 within 24;
 * left in canvas units the pull was 24 px at 4x and a barely-there 1.5 px at 0.25x. A zoom that
 * can't be divided by (zero, NaN) reads as 1.
 */
export function snapReach(zoom: number): SnapReach {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { threshold: SNAP_THRESHOLD / scale, connectorThreshold: CONNECTOR_SNAP_THRESHOLD / scale };
}

export interface Guide {
  axis: 'x' | 'y';
  /** Position of the guide on its axis. */
  at: number;
  /** The extent to draw, so a guide spans only the nodes it relates. */
  from: number;
  to: number;
  /**
   * What it shows: an edge or centre lined up (absent), a connector that now runs straight
   * (`connector`), or one of a run of equal gaps (`gap`, drawn as a measured span with `label`).
   */
  kind?: 'connector' | 'gap';
  /** A gap's size, as shown beside it. */
  label?: string;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

/**
 * A connector between the moving shapes and a resting one, measured where the moving end is now:
 * how far the moving shapes would have to travel on `axis` for it to run straight
 * (`edges/straight.ts`), and the line it would then run along.
 */
export interface SnapLink {
  axis: 'x' | 'y';
  delta: number;
  /** The straight line's position on `axis` and its extent across it. */
  at: number;
  from: number;
  to: number;
}

export interface SnapOptions {
  links?: readonly SnapLink[];
  /** How far a connector's straight line pulls, in canvas units; `snapReach` has it for a zoom.
   *  Absent: `CONNECTOR_SNAP_THRESHOLD`, as at zoom 1. */
  connectorThreshold?: number;
  /** Shapes to measure even spacing against — the resting ones, less boundaries, whose own box
   *  contains the shapes it spaces. Absent: no spacing snap (a resize never takes one). */
  spacing?: readonly Rect[];
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] };

interface Candidate {
  delta: number;
  guides: Guide[];
}

/** The nearer of two candidates; a tie keeps both sets of guides, since both are true. */
function nearer(a: Candidate | null, b: Candidate | null): Candidate | null {
  if (!a) return b;
  if (!b) return a;
  if (Math.abs(Math.abs(a.delta) - Math.abs(b.delta)) < 0.01 && Math.abs(a.delta - b.delta) < 0.5) {
    return { delta: a.delta, guides: [...a.guides, ...b.guides] };
  }
  return Math.abs(b.delta) < Math.abs(a.delta) ? b : a;
}

/**
 * Finds the snap for the moving bounds against static neighbours.
 *
 * The guide returned spans just far enough to show what it lined up with.
 */
export function computeSnap(
  moving: Rect,
  statics: readonly Rect[],
  threshold = SNAP_THRESHOLD,
  options: SnapOptions = {},
): SnapResult {
  const links = options.links ?? [];
  if (statics.length === 0 && links.length === 0) return NO_SNAP;

  const edges = edgeCandidates(moving, statics, threshold);
  const spacingX = options.spacing ? spacingCandidate(moving, options.spacing, 'x', threshold) : null;
  const spacingY = options.spacing ? spacingCandidate(moving, options.spacing, 'y', threshold) : null;
  // The spacing guides are measured where the shape lands, which the other axis's snap may move;
  // they are shifted by it below, once both are known.
  let bestX = nearer(edges.x, spacingX);
  let bestY = nearer(edges.y, spacingY);

  const connectorThreshold = options.connectorThreshold ?? CONNECTOR_SNAP_THRESHOLD;
  const straightX = connectorCandidate(links, 'x', connectorThreshold);
  const straightY = connectorCandidate(links, 'y', connectorThreshold);
  if (straightX) bestX = straightX;
  if (straightY) bestY = straightY;

  const dx = bestX?.delta ?? 0;
  const dy = bestY?.delta ?? 0;
  const guides: Guide[] = [
    ...(bestX?.guides ?? []).map((guide) => shiftAcross(guide, dy)),
    ...(bestY?.guides ?? []).map((guide) => shiftAcross(guide, dx)),
  ];
  return { dx, dy, guides };
}

/** A spacing mark follows its shape when the other axis snaps too. Lines that merely span the
 *  shape are long enough either way. */
function shiftAcross(guide: Guide, by: number): Guide {
  return guide.kind === 'gap' && by !== 0 ? { ...guide, at: guide.at + by } : guide;
}

/** The three lines of a box on one axis — start, middle, end — written into scratch arrays that live
 *  at module level: this runs for every resting shape on every frame of a drag, and a pair of fresh
 *  arrays per shape was most of what it allocated. Safe because nothing here awaits or recurses. */
const movingEdgesX = [0, 0, 0];
const movingEdgesY = [0, 0, 0];
const otherEdgesX = [0, 0, 0];
const otherEdgesY = [0, 0, 0];

function linesOf(into: number[], start: number, size: number): number[] {
  into[0] = start;
  into[1] = start + size / 2;
  into[2] = start + size;
  return into;
}

function edgeCandidates(moving: Rect, statics: readonly Rect[], threshold: number): { x: Candidate | null; y: Candidate | null } {
  linesOf(movingEdgesX, moving.x, moving.width);
  linesOf(movingEdgesY, moving.y, moving.height);

  let bestX: Candidate | null = null;
  let bestY: Candidate | null = null;

  for (const other of statics) {
    linesOf(otherEdgesX, other.x, other.width);
    linesOf(otherEdgesY, other.y, other.height);

    for (const from of movingEdgesX) {
      for (const to of otherEdgesX) {
        const delta = to - from;
        if (Math.abs(delta) > threshold) continue;
        if (bestX && Math.abs(bestX.delta) <= Math.abs(delta)) continue;
        bestX = {
          delta,
          guides: [{ axis: 'x', at: to, from: Math.min(moving.y, other.y), to: Math.max(moving.y + moving.height, other.y + other.height) }],
        };
      }
    }

    for (const from of movingEdgesY) {
      for (const to of otherEdgesY) {
        const delta = to - from;
        if (Math.abs(delta) > threshold) continue;
        if (bestY && Math.abs(bestY.delta) <= Math.abs(delta)) continue;
        bestY = {
          delta,
          guides: [{ axis: 'y', at: to, from: Math.min(moving.x, other.x), to: Math.max(moving.x + moving.width, other.x + other.width) }],
        };
      }
    }
  }
  return { x: bestX, y: bestY };
}

/** The nearest connector on `axis` within `threshold`, with every other one the same move
 *  straightens as well. */
function connectorCandidate(links: readonly SnapLink[], axis: 'x' | 'y', threshold: number): Candidate | null {
  let best: SnapLink | undefined;
  for (const link of links) {
    if (link.axis !== axis || Math.abs(link.delta) > threshold) continue;
    if (!best || Math.abs(link.delta) < Math.abs(best.delta)) best = link;
  }
  if (!best) return null;
  const delta = best.delta;
  // A guide runs along the line itself: a level connector (straightened on `y`) gets a horizontal
  // guide, which is a `y` guide.
  const straightened = links.filter((link) => link.axis === axis && Math.abs(link.delta - delta) < 0.5);
  return {
    delta,
    guides: straightened.map((link) => ({ axis, at: link.at, from: link.from, to: link.to, kind: 'connector' as const })),
  };
}

/**
 * Even spacing along `axis` (`x`: a row, side by side): the shapes that share the moving one's row,
 * the gaps already between them, and the positions that would repeat one of those gaps beside the
 * moving shape's nearest neighbour — or centre it between its two. The nearest within `threshold`
 * wins, and every gap of that size in the row is marked.
 */
function spacingCandidate(moving: Rect, rects: readonly Rect[], axis: 'x' | 'y', threshold: number): Candidate | null {
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.width : r.height);
  const end = (r: Rect) => start(r) + size(r);
  const crossStart = (r: Rect) => (axis === 'x' ? r.y : r.x);
  const crossEnd = (r: Rect) => crossStart(r) + (axis === 'x' ? r.height : r.width);
  const shareRow = (a: Rect, b: Rect) => crossStart(a) < crossEnd(b) && crossStart(b) < crossEnd(a);

  const row = rects.filter((r) => shareRow(r, moving)).sort((a, b) => start(a) - start(b));
  if (row.length === 0) return null;

  let before: Rect | undefined;
  let after: Rect | undefined;
  for (const r of row) {
    if (start(r) < start(moving) && end(r) <= start(moving) + threshold && (!before || end(r) > end(before))) before = r;
    if (start(r) > start(moving) && start(r) >= end(moving) - threshold && (!after || start(r) < start(after))) after = r;
  }
  if (!before && !after) return null;

  // The gaps already in the row, between neighbours that share it with each other too.
  const pairs: { a: Rect; b: Rect; gap: number }[] = [];
  for (let i = 0; i < row.length - 1; i += 1) {
    const a = row[i]!;
    // Its nearest neighbour further along, not merely the next to start. The row is sorted by start,
    // so the first that qualifies is the nearest: stopping there keeps a drag past a tall row (a
    // boundary spanning the diagram) from scanning every pair on every pointer move.
    let b: Rect | undefined;
    for (let j = i + 1; j < row.length; j += 1) {
      const candidate = row[j]!;
      if (start(candidate) >= end(a) && shareRow(a, candidate)) {
        b = candidate;
        break;
      }
    }
    // Not the two the moving shape sits between: that gap is its own, not one already there.
    if (b && !(end(a) <= start(moving) + threshold && start(b) >= end(moving) - threshold)) pairs.push({ a, b, gap: start(b) - end(a) });
  }

  let best: { delta: number; gap: number; centred: boolean } | null = null;
  const consider = (delta: number, gap: number, centred: boolean) => {
    if (Math.abs(delta) > threshold || gap <= 0) return;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, gap, centred };
  };
  for (const { gap } of pairs) {
    if (before) consider(end(before) + gap - start(moving), gap, false);
    if (after) consider(start(after) - gap - end(moving), gap, false);
  }
  if (before && after) {
    const free = start(after) - end(before) - size(moving);
    if (free > 0) consider(end(before) + free / 2 - start(moving), free / 2, true);
  }
  if (!best) return null;
  const chosen: { delta: number; gap: number; centred: boolean } = best;

  const landed: Rect = axis === 'x' ? { ...moving, x: moving.x + chosen.delta } : { ...moving, y: moving.y + chosen.delta };
  const mark = (a: Rect, b: Rect): Guide => {
    // Across the middle of what the two have in common, so the mark sits between them.
    const at = (Math.max(crossStart(a), crossStart(b)) + Math.min(crossEnd(a), crossEnd(b))) / 2;
    return { axis: axis === 'x' ? 'y' : 'x', at, from: end(a), to: start(b), kind: 'gap', label: String(Math.round(start(b) - end(a))) };
  };
  const guides: Guide[] = [];
  if (before && Math.abs(start(landed) - end(before) - chosen.gap) < 0.5) guides.push(mark(before, landed));
  if (after && Math.abs(start(after) - end(landed) - chosen.gap) < 0.5) guides.push(mark(landed, after));
  for (const pair of pairs) if (Math.abs(pair.gap - chosen.gap) < 0.5) guides.push(mark(pair.a, pair.b));
  return { delta: chosen.delta, guides };
}

/** Guides only change when alignment is gained or lost, not every frame. */
export function sameGuides(a: readonly Guide[], b: readonly Guide[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((guide, index) => {
    const other = b[index]!;
    return (
      guide.axis === other.axis &&
      guide.kind === other.kind &&
      guide.label === other.label &&
      Math.abs(guide.at - other.at) < 0.5 &&
      Math.abs(guide.from - other.from) < 0.5 &&
      Math.abs(guide.to - other.to) < 0.5
    );
  });
}
