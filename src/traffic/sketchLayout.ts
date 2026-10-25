/**
 * Traffic findings are placed as if somebody had room to walk around the diagram with a marker.
 * The layout is deliberately derived and local: it gives the renderer stable geometry without
 * making the annotation part of the document or teaching the traffic analysis about pixels.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SketchRequest {
  id: string;
  targets: Rect[];
  label: string;
  priority: number;
}

export interface PlacedSketch {
  id: string;
  rings: Rect[];
  label: { x: number; y: number; width: number; height: number; lines: string[] };
  arrow: { from: Point; control: Point; to: Point };
}

export interface SketchLayoutOptions {
  charWidth?: number;
  lineHeight?: number;
  maxChars?: number;
  gap?: number;
  ringPad?: number;
}

interface LayoutValues {
  charWidth: number;
  lineHeight: number;
  maxChars: number;
  gap: number;
  ringPad: number;
}

interface Candidate {
  rect: Rect;
  tier: number;
  preference: number;
}

interface PlacedRecord {
  sketch: PlacedSketch;
  label: Rect;
  rings: Rect[];
  arrowBounds: Rect;
}

type Compass = 'NE' | 'NW' | 'E' | 'W' | 'SE' | 'SW' | 'N' | 'S';

const COMPASS: readonly Compass[] = [
  'NE',
  'NW',
  'E',
  'W',
  'SE',
  'SW',
  'N',
  'S',
];

const TIER_PENALTIES = [0, 400, 1200] as const;

function rectWithPadding(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function right(rect: Rect): number {
  return rect.x + rect.width;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
  return width * height;
}

function distanceToRect(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - right(b), b.x - right(a), 0);
  const dy = Math.max(a.y - bottom(b), b.y - bottom(a), 0);
  return Math.hypot(dx, dy);
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function wrapLabel(label: string, maxChars: number): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);

  if (lines.length <= 3) return lines;

  const result = lines.slice(0, 3);
  const last = result[2] ?? '';
  result[2] = last.length >= maxChars
    ? `${last.slice(0, Math.max(0, maxChars - 1))}…`
    : `${last}…`;
  return result;
}

function labelSize(label: string, values: LayoutValues): { width: number; height: number; lines: string[] } {
  const lines = wrapLabel(label, values.maxChars);
  const longest = lines.reduce((length, line) => Math.max(length, line.length), 0);
  return {
    width: longest * values.charWidth + 8,
    height: lines.length * values.lineHeight + 6,
    lines,
  };
}

function candidateAt(ring: Rect, width: number, height: number, gap: number, compass: Compass): Rect {
  const ringRight = right(ring);
  const ringBottom = bottom(ring);
  const ringCentre = centre(ring);
  switch (compass) {
    case 'NE':
      return { x: ringRight + gap, y: ring.y - gap - height, width, height };
    case 'NW':
      return { x: ring.x - gap - width, y: ring.y - gap - height, width, height };
    case 'E':
      return { x: ringRight + gap, y: ringCentre.y - height / 2, width, height };
    case 'W':
      return { x: ring.x - gap - width, y: ringCentre.y - height / 2, width, height };
    case 'SE':
      return { x: ringRight + gap, y: ringBottom + gap, width, height };
    case 'SW':
      return { x: ring.x - gap - width, y: ringBottom + gap, width, height };
    case 'N':
      return { x: ringCentre.x - width / 2, y: ring.y - gap - height, width, height };
    case 'S':
      return { x: ringCentre.x - width / 2, y: ringBottom + gap, width, height };
  }
}

function candidatesFor(ring: Rect, width: number, height: number, values: LayoutValues): Candidate[] {
  const candidates: Candidate[] = [];
  for (let tier = 0; tier < TIER_PENALTIES.length; tier += 1) {
    const tierGap = values.gap * (tier + 1);
    for (let preference = 0; preference < COMPASS.length; preference += 1) {
      const compass = COMPASS[preference]!;
      candidates.push({
        rect: candidateAt(ring, width, height, tierGap, compass),
        tier,
        preference,
      });
    }
  }
  return candidates;
}

function nearestBorderPoint(rect: Rect, target: Point): Point {
  const left = rect.x;
  const top = rect.y;
  const rectRight = right(rect);
  const rectBottom = bottom(rect);
  const x = Math.max(left, Math.min(rectRight, target.x));
  const y = Math.max(top, Math.min(rectBottom, target.y));

  if (target.x < left || target.x > rectRight || target.y < top || target.y > rectBottom) return { x, y };

  const distances = [
    { distance: target.x - left, point: { x: left, y: target.y } },
    { distance: rectRight - target.x, point: { x: rectRight, y: target.y } },
    { distance: target.y - top, point: { x: target.x, y: top } },
    { distance: rectBottom - target.y, point: { x: target.x, y: rectBottom } },
  ];
  return distances.reduce((best, current) => current.distance < best.distance ? current : best).point;
}

function ellipsePoint(ring: Rect, from: Point): Point {
  const ringCentre = centre(ring);
  const a = ring.width / 2;
  const b = ring.height / 2;
  const dx = from.x - ringCentre.x;
  const dy = from.y - ringCentre.y;
  const denominator = Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
  if (!Number.isFinite(denominator) || denominator === 0) return { x: ringCentre.x + a, y: ringCentre.y };
  return {
    x: ringCentre.x + dx / denominator,
    y: ringCentre.y + dy / denominator,
  };
}

export function arrowFor(label: Rect, ring: Rect): { from: Point; control: Point; to: Point } {
  const ringCentre = centre(ring);
  const from = nearestBorderPoint(label, ringCentre);
  const to = ellipsePoint(ring, from);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const control = {
    x: midpoint.x - dy * 0.22,
    y: midpoint.y + dx * 0.22,
  };
  return { from, control, to };
}

function boundsOfArrow(arrow: { from: Point; control: Point; to: Point }): Rect {
  const x = Math.min(arrow.from.x, arrow.control.x, arrow.to.x);
  const y = Math.min(arrow.from.y, arrow.control.y, arrow.to.y);
  return {
    x,
    y,
    width: Math.max(arrow.from.x, arrow.control.x, arrow.to.x) - x,
    height: Math.max(arrow.from.y, arrow.control.y, arrow.to.y) - y,
  };
}

function scoreCandidate(candidate: Candidate, obstacles: readonly Rect[], placed: readonly PlacedRecord[]): number {
  let score = TIER_PENALTIES[candidate.tier]! + candidate.preference;
  for (const obstacle of obstacles) score += overlapArea(candidate.rect, obstacle) * 10;
  for (const record of placed) {
    score += overlapArea(candidate.rect, record.label) * 25;
    for (const ring of record.rings) score += overlapArea(candidate.rect, ring) * 25;
    score += overlapArea(candidate.rect, record.arrowBounds) * 2;
  }
  return score;
}

function valuesOf(options: SketchLayoutOptions | undefined): LayoutValues {
  return {
    charWidth: options?.charWidth ?? 8.4,
    lineHeight: options?.lineHeight ?? 21,
    maxChars: Math.max(1, Math.floor(options?.maxChars ?? 24)),
    gap: options?.gap ?? 34,
    ringPad: options?.ringPad ?? 12,
  };
}

export function placeSketches(
  requests: readonly SketchRequest[],
  obstacles: readonly Rect[],
  options?: SketchLayoutOptions,
): PlacedSketch[] {
  const values = valuesOf(options);
  const sorted = requests
    .filter((request) => request.targets.length > 0)
    .slice()
    .sort((a, b) => a.priority - b.priority || compareId(a.id, b.id));
  const targetObstacles = sorted.flatMap((request) => request.targets);
  const paddedObstacles = [...obstacles, ...targetObstacles].map((rect) => rectWithPadding(rect, 6));
  const placed: PlacedRecord[] = [];

  for (const request of sorted) {
    const rings = request.targets.map((target) => rectWithPadding(target, values.ringPad));
    const firstRing = rings[0]!;
    const relevantObstacles = paddedObstacles.filter((obstacle) => distanceToRect(obstacle, firstRing) <= 400);
    const size = labelSize(request.label, values);
    const candidates = candidatesFor(firstRing, size.width, size.height, values);
    let best = candidates[0]!;
    let bestScore = scoreCandidate(best, relevantObstacles, placed);
    for (const candidate of candidates.slice(1)) {
      const score = scoreCandidate(candidate, relevantObstacles, placed);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    const arrow = arrowFor(best.rect, firstRing);
    const sketch: PlacedSketch = {
      id: request.id,
      rings,
      label: { ...best.rect, lines: size.lines.slice() },
      arrow,
    };
    placed.push({ sketch, label: best.rect, rings, arrowBounds: boundsOfArrow(arrow) });
  }

  return placed.map((record) => record.sketch);
}
