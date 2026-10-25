/**
 * How good a view's connectors are, measured on the lines both renderers actually draw: the request
 * line and, for a request/response connector, its reply.
 *
 * Hard rules are counted as violations. Quality is a vector compared most important first:
 *   1. obstruction — lines through shapes, captions over shapes, captions on captions;
 *   2. accidental overlap — two lines drawn on top of each other that are not grouped on purpose
 *      (a shared trunk, a shared label and a connector's own reply are on purpose);
 *   3. crossings;
 *   4. length plus 48 per bend.
 */

import type { DraftEdge, DraftNode } from '../../../src/document/types';
import { drawnConnectors, type DrawnConnector, type DrawnLine } from './drawn';
import { flattenPath, rectOf, type Rect, type Side } from '../../../src/edges/routing';
import { stepPolyline } from '../../../src/edges/waypoints';
import { endpointPlan } from '../../../src/edges/endpoints';
import { separationPlan } from '../../../src/edges/separation';

interface Point {
  x: number;
  y: number;
}

export interface Quality {
  /** Hard rules: must stay at zero (pins are counted, and enforced once the pin contract lands). */
  violations: { endpoint: number; continuity: number; bends: number; pins: number };
  tiers: { obstruction: number; overlap: number; crossings: number; cost: number };
  /** Lines the router could not route clear, by status, and crowded node sides. */
  unresolved: { blocked: number; budget: number; crowded: number; skipped: number };
  /** Per-edge detail behind the numbers, for reading a regression. */
  detail: { through: string[]; overlapping: string[]; pinsMoved: string[] };
}

const BEND_COST = 48;
/** Inset of a shape before a line counts as entering it — `segmentEntersRect`'s. */
const THROUGH_INSET = 3;
/** How far a caption may overlap a shape's border — `routeProblem`'s. */
const CAPTION_INSET = 6;
/** Closer than this, two parallel runs read as one line. */
const SAME_LINE = 6;
/** Two lines leaving one point share their stub; past this they read as one line. */
const SHARED_RUN = 30;

const inset = (r: Rect, by: number): Rect => ({ x: r.x + by, y: r.y + by, width: r.width - 2 * by, height: r.height - 2 * by });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Liang–Barsky: does any part of segment `a`→`b` lie strictly inside `r`? */
function entersRect(a: Point, b: Point, r: Rect): boolean {
  if (r.width <= 0 || r.height <= 0) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.width - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.height - a.y) && t1 - t0 > 1e-6;
}

function boundsOf(points: readonly Point[]): Rect {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Where `a`→`b` and `c`→`d` properly cross, away from either segment's ends. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  const lenR = Math.hypot(r.x, r.y);
  const lenS = Math.hypot(s.x, s.y);
  const margin = 2;
  if (t * lenR < margin || (1 - t) * lenR < margin || u * lenS < margin || (1 - u) * lenS < margin) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** Total length two corner polylines draw along the same horizontal or vertical line. */
function sharedLength(a: readonly Point[], b: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < a.length; i += 1) {
    const [a0, a1] = [a[i - 1]!, a[i]!];
    for (let j = 1; j < b.length; j += 1) {
      const [b0, b1] = [b[j - 1]!, b[j]!];
      if (Math.abs(a0.y - a1.y) < 1 && Math.abs(b0.y - b1.y) < 1 && Math.abs(a0.y - b0.y) < SAME_LINE) {
        total += Math.max(0, Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)));
      } else if (Math.abs(a0.x - a1.x) < 1 && Math.abs(b0.x - b1.x) < 1 && Math.abs(a0.x - b0.x) < SAME_LINE) {
        total += Math.max(0, Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y)) - Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y)));
      }
    }
  }
  return total;
}

function bendsOf(points: readonly Point[]): number {
  let bends = 0;
  for (let i = 1; i + 1 < points.length; i += 1) {
    const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-6) bends += 1;
  }
  return bends;
}

function lengthOf(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

/** Where a side's anchors land: the line they sit on and the stretch along it. */
function sideLine(rect: Rect, side: Side): { fixed: number; from: number; to: number; horizontal: boolean } {
  const band = rect.anchorBand;
  switch (side) {
    case 'left':
      return { fixed: band?.left ?? rect.x, from: band?.top ?? rect.y, to: band?.bottom ?? rect.y + rect.height, horizontal: true };
    case 'right':
      return { fixed: band?.right ?? rect.x + rect.width, from: band?.top ?? rect.y, to: band?.bottom ?? rect.y + rect.height, horizontal: true };
    case 'top':
      return { fixed: band?.glyphTop ?? rect.y, from: rect.x, to: rect.x + rect.width, horizontal: false };
    case 'bottom':
      return { fixed: rect.y + rect.height, from: rect.x, to: rect.x + rect.width, horizontal: false };
  }
}

/** The part of a shape its anchors land on: the glyph of a Data Store or tube, else the box. */
function glyphOf(rect: Rect): Rect {
  const band = rect.anchorBand;
  if (!band) return rect;
  const left = band.left ?? rect.x;
  const right = band.right ?? rect.x + rect.width;
  const top = band.glyphTop ?? rect.y;
  return { x: left, y: top, width: right - left, height: rect.y + rect.height - top };
}

/** An end point lies on its side's anchor line, within that side's extent. */
function onSide(point: Point, rect: Rect, side: Side): boolean {
  const line = sideLine(rect, side);
  const [fixed, along] = line.horizontal ? [point.x, point.y] : [point.y, point.x];
  return Math.abs(fixed - line.fixed) <= 1 && along >= line.from - 1 && along <= line.to + 1;
}

/** A pinned end holds when it is drawn on its side, within ⅜ of a slot gap of its anchor point. */
function pinHolds(point: Point, side: Side, rect: Rect, anchor: NonNullable<DraftEdge['sourceAnchor']>): boolean {
  if (side !== anchor.side) return false;
  const line = sideLine(rect, side);
  const at = line.from + (line.to - line.from) * anchor.offset;
  const along = line.horizontal ? point.y : point.x;
  return Math.abs(along - at) <= (line.to - line.from) * 0.25 * 0.375 + 1;
}

/** Whether every hand-placed bend lies on the drawn line. */
function bendsKept(points: readonly Point[], waypoints: readonly Point[]): boolean {
  return waypoints.every((w) => points.some((p, i) => {
    if (i === 0) return false;
    const a = points[i - 1]!;
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(a.x + t * dx - w.x, a.y + t * dy - w.y) <= 1.5;
  }));
}

function cornersOf(line: DrawnLine, routing: DraftEdge['routing']): Point[] {
  if (routing === 'smoothstep') {
    const corners = stepPolyline(line.d);
    if (corners.length >= 2) return corners;
  }
  return flattenPath(line.d).map(({ x, y }) => ({ x, y }));
}

interface Measured {
  connector: DrawnConnector;
  line: DrawnLine;
  role: 'request' | 'response';
  drawn: Point[];
  corners: Point[];
  bounds: Rect;
}

export function measure(nodes: readonly DraftNode[], edges: readonly DraftEdge[], options: { spread?: boolean } = {}): Quality {
  const connectors = drawnConnectors(nodes, edges, options);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const solid = nodes.filter((n) => n.type !== 'group').map((n) => ({ id: n.id, rect: rectOf(n), box: inset(rectOf(n), THROUGH_INSET) }));
  const quality: Quality = {
    violations: { endpoint: 0, continuity: 0, bends: 0, pins: 0 },
    tiers: { obstruction: 0, overlap: 0, crossings: 0, cost: 0 },
    unresolved: { blocked: 0, budget: 0, crowded: 0, skipped: 0 },
    detail: { through: [], overlapping: [], pinsMoved: [] },
  };

  const lines: Measured[] = [];
  for (const connector of connectors) {
    for (const [role, line] of [['request', connector.request], ['response', connector.response]] as const) {
      if (!line) continue;
      const drawn = flattenPath(line.d).map(({ x, y }) => ({ x, y }));
      if (drawn.length < 2) {
        quality.violations.continuity += 1;
        continue;
      }
      if ((line.d.match(/M/gi) ?? []).length !== 1) quality.violations.continuity += 1;
      if (line.status === 'blocked') quality.unresolved.blocked += 1;
      if (line.status === 'budget') quality.unresolved.budget += 1;
      lines.push({ connector, line, role, drawn, corners: cornersOf(line, connector.edge.routing), bounds: boundsOf(drawn) });
    }
  }

  for (const m of lines) {
    const { edge } = m.connector;
    const [startId, endId] = m.role === 'request' ? [edge.source, edge.target] : [edge.target, edge.source];
    const start = byId.get(startId);
    const end = byId.get(endId);
    if (!start || !end) continue;
    const startRect = rectOf(start);
    const endRect = rectOf(end);
    // Hard rules.
    const first = m.drawn[0]!;
    const last = m.drawn[m.drawn.length - 1]!;
    if (Math.hypot(first.x - m.line.source.x, first.y - m.line.source.y) > 1 || Math.hypot(last.x - m.line.target.x, last.y - m.line.target.y) > 1) {
      quality.violations.continuity += 1;
    }
    if (!onSide(m.line.source, startRect, m.line.source.side) || !onSide(m.line.target, endRect, m.line.target.side)) quality.violations.endpoint += 1;
    if (edge.waypoints?.length && m.role === 'request' && edge.routing === 'smoothstep' && !bendsKept(m.corners, edge.waypoints)) quality.violations.bends += 1;
    if (m.role === 'request') {
      const moved = (edge.sourceAnchor && !pinHolds(m.line.source, m.line.source.side, startRect, edge.sourceAnchor))
        || (edge.targetAnchor && !pinHolds(m.line.target, m.line.target.side, endRect, edge.targetAnchor));
      if (moved) {
        quality.violations.pins += 1;
        quality.detail.pinsMoved.push(edge.id);
      }
    }

    // Tier 1: through shapes — any unrelated shape, and its own two ends past the stub it leaves by.
    // A line leaves and lands on a shape's border, outside its inset box. A Data Store or a tube
    // takes its anchors on the glyph inside its box, so for its own ends the line may cross the margin
    // around the glyph and only the glyph counts.
    let through = 0;
    for (const shape of solid) {
      if (!overlaps(m.bounds, shape.rect)) continue;
      const own = shape.id === startId || shape.id === endId;
      const box = own ? inset(glyphOf(shape.rect), THROUGH_INSET) : shape.box;
      if (m.drawn.some((p, k) => k > 0 && entersRect(m.drawn[k - 1]!, p, box))) through += 1;
    }
    if (through) quality.detail.through.push(`${edge.id}${m.role === 'response' ? ':reply' : ''}`);
    quality.tiers.obstruction += through;
    quality.tiers.cost += lengthOf(m.drawn) + BEND_COST * bendsOf(m.corners);
  }

  // Tier 1: captions over shapes and over each other.
  const chips = connectors.flatMap((c) => (c.chip ? [{ id: c.edge.id, chip: c.chip, group: c.labelGroup }] : []));
  for (const { chip } of chips) {
    if (solid.some((s) => s.rect.width > 2 * CAPTION_INSET && overlaps(chip, inset(s.rect, CAPTION_INSET)))) quality.tiers.obstruction += 1;
  }
  for (let i = 0; i < chips.length; i += 1) {
    for (let j = i + 1; j < chips.length; j += 1) {
      const [a, b] = [chips[i]!, chips[j]!];
      if (a.group && a.group === b.group) continue;
      if (overlaps(a.chip, b.chip)) quality.tiers.obstruction += 1;
    }
  }

  // Tiers 2 and 3, pair by pair.
  const together = (a: Measured, b: Measured) =>
    a.connector === b.connector
    || Boolean(a.connector.spine && a.connector.spine === b.connector.spine && a.role === b.role)
    || Boolean(a.connector.labelGroup && a.connector.labelGroup === b.connector.labelGroup && a.role === 'request' && b.role === 'request');
  const places = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const a = lines[i]!;
    for (let j = i + 1; j < lines.length; j += 1) {
      const b = lines[j]!;
      if (!overlaps({ ...a.bounds, x: a.bounds.x - SAME_LINE, y: a.bounds.y - SAME_LINE, width: a.bounds.width + 2 * SAME_LINE, height: a.bounds.height + 2 * SAME_LINE }, b.bounds)) continue;
      if (together(a, b)) continue;
      const shared = sharedLength(a.corners, b.corners);
      if (shared > SHARED_RUN) {
        quality.tiers.overlap += Math.round(shared);
        quality.detail.overlapping.push(`${a.connector.edge.id}|${b.connector.edge.id}`);
      }
      for (let p = 1; p < a.corners.length; p += 1) {
        for (let q = 1; q < b.corners.length; q += 1) {
          const at = crossing(a.corners[p - 1]!, a.corners[p]!, b.corners[q - 1]!, b.corners[q]!);
          if (at) places.add(`${i}|${j}|${Math.round(at.x)}|${Math.round(at.y)}`);
        }
      }
    }
  }
  quality.tiers.crossings = places.size;
  quality.unresolved.crowded = options.spread === false ? 0 : endpointPlan(nodes, edges, 'transient').crowded.length;
  quality.unresolved.skipped = separationPlan(nodes, edges, 'transient').skipped;
  quality.tiers.cost = Math.round(quality.tiers.cost);
  return quality;
}

/** Most important first: is `next` no worse than `base`, tier by tier? */
export function noWorse(next: Quality['tiers'], base: Quality['tiers']): boolean {
  const order = ['obstruction', 'overlap', 'crossings', 'cost'] as const;
  for (const tier of order) {
    // Length moves by fractions of a pixel between equivalent routes; a 1% band keeps the last tier honest.
    const slack = tier === 'cost' ? Math.max(2, base.cost * 0.01) : 0;
    if (next[tier] < base[tier] - slack) return true;
    if (next[tier] > base[tier] + slack) return false;
  }
  return true;
}
