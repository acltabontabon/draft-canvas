/**
 * Generated handwriting for the Smart Ink recognizer: every drawing is deterministic (a seeded
 * generator), so a threshold change that breaks one shows up as the same failure every run.
 *
 * Drawings are imperfect the way hands are: the line wanders slowly (a sum of low-frequency waves),
 * jitters a little, overshoots corners, starts anywhere along the outline and does not always close.
 * Coordinates are screen pixels at zoom 1.
 */
import type { Pt } from '../../src/ink/geometry';

export function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Hand {
  /** Slow wander, in px. */
  wobble: number;
  /** Per-point jitter, in px. */
  jitter: number;
  random: () => number;
}

export function hand(seed: number, wobble = 2, jitter = 0.6): Hand {
  return { wobble, jitter, random: rng(seed) };
}

/** Densify a polyline to roughly one point per `step` px, as a pointer would sample it. */
function densify(points: readonly Pt[], step = 2.5): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k += 1) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** The hand's imperfection applied along a path. */
export function humanize(points: readonly Pt[], h: Hand): Pt[] {
  const dense = densify(points);
  const phases = [h.random() * 6.28, h.random() * 6.28, h.random() * 6.28, h.random() * 6.28];
  const n = dense.length;
  return dense.map((p, i) => {
    const t = i / Math.max(1, n - 1);
    const wx = Math.sin(t * 5.1 + phases[0]!) * 0.6 + Math.sin(t * 11.3 + phases[1]!) * 0.4;
    const wy = Math.sin(t * 4.7 + phases[2]!) * 0.6 + Math.sin(t * 9.9 + phases[3]!) * 0.4;
    return {
      x: p.x + wx * h.wobble + (h.random() - 0.5) * 2 * h.jitter,
      y: p.y + wy * h.wobble + (h.random() - 0.5) * 2 * h.jitter,
    };
  });
}

function rotate(points: Pt[], start: number): Pt[] {
  return [...points.slice(start), ...points.slice(0, start)];
}

/** One continuous rectangle, starting at a random corner, with optional overshoot and gap. */
export function rectangle(x: number, y: number, w: number, h: number, hd: Hand, options: { gap?: number; overshoot?: number; radius?: number } = {}): Pt[][] {
  const r = options.radius ?? 0;
  let outline: Pt[];
  if (r > 0) {
    outline = [];
    const corners = [
      { cx: x + w - r, cy: y + r, from: -Math.PI / 2 },
      { cx: x + w - r, cy: y + h - r, from: 0 },
      { cx: x + r, cy: y + h - r, from: Math.PI / 2 },
      { cx: x + r, cy: y + r, from: Math.PI },
    ];
    for (const corner of corners) {
      for (let k = 0; k <= 6; k += 1) {
        const a = corner.from + (k / 6) * (Math.PI / 2);
        outline.push({ x: corner.cx + Math.cos(a) * r, y: corner.cy + Math.sin(a) * r });
      }
    }
  } else {
    outline = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }
  outline = rotate(outline, Math.floor(hd.random() * outline.length));
  const first = outline[0]!;
  const overshoot = options.overshoot ?? 0;
  const closed = [...outline, first];
  // Stop short of closing by `gap`, or carry on past the start by `overshoot`.
  const last = closed[closed.length - 2]!;
  const gap = options.gap ?? 0;
  const length = Math.hypot(first.x - last.x, first.y - last.y);
  const t = Math.max(0, Math.min(1.2, (length - gap + overshoot) / length));
  closed[closed.length - 1] = { x: last.x + (first.x - last.x) * t, y: last.y + (first.y - last.y) * t };
  return [humanize(closed, hd)];
}

/** A rectangle drawn as four separate sides, each slightly overshooting its corners. */
export function rectangleFourStrokes(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  const o = 4;
  return [
    humanize([{ x: x - o, y }, { x: x + w + o, y }], hd),
    humanize([{ x: x + w, y: y - o }, { x: x + w, y: y + h + o }], hd),
    humanize([{ x: x + w + o, y: y + h }, { x: x - o, y: y + h }], hd),
    humanize([{ x, y: y + h + o }, { x, y: y - o }], hd),
  ];
}

/** A rectangle drawn as two "L" strokes. */
export function rectangleTwoStrokes(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  return [
    humanize([{ x, y: y + h }, { x, y }, { x: x + w, y }], hd),
    humanize([{ x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], hd),
  ];
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, hd: Hand, options: { sweep?: number } = {}): Pt[][] {
  const start = hd.random() * Math.PI * 2;
  const sweep = options.sweep ?? Math.PI * 2;
  const points: Pt[] = [];
  const n = 48;
  for (let k = 0; k <= n; k += 1) {
    const a = start + (k / n) * sweep;
    points.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return [humanize(points, hd)];
}

export function line(from: Pt, to: Pt, hd: Hand): Pt[][] {
  return [humanize([from, to], hd)];
}

function barbs(from: Pt, to: Pt, length: number, angleDeg: number): [Pt, Pt] {
  const back = Math.atan2(from.y - to.y, from.x - to.x);
  const a = (angleDeg * Math.PI) / 180;
  return [
    { x: to.x + Math.cos(back + a) * length, y: to.y + Math.sin(back + a) * length },
    { x: to.x + Math.cos(back - a) * length, y: to.y + Math.sin(back - a) * length },
  ];
}

/** An arrow in one stroke: the shaft, then one barb, back to the tip, then the other. */
export function arrowOneStroke(from: Pt, to: Pt, hd: Hand, options: { headLength?: number; angle?: number } = {}): Pt[][] {
  const [b1, b2] = barbs(from, to, options.headLength ?? 18, options.angle ?? 32);
  return [humanize([from, to, b1, to, b2], hd)];
}

/** An arrow whose head is a separate "V" stroke. */
export function arrowSeparateHead(from: Pt, to: Pt, hd: Hand, options: { headLength?: number; angle?: number } = {}): Pt[][] {
  const [b1, b2] = barbs(from, to, options.headLength ?? 18, options.angle ?? 32);
  return [humanize([from, to], hd), humanize([b1, to, b2], hd)];
}

/** An arrow with a single barb — a lazy half head. */
export function arrowHalfHead(from: Pt, to: Pt, hd: Hand): Pt[][] {
  const [b1] = barbs(from, to, 18, 35);
  return [humanize([from, to, b1], hd)];
}

/** A Data Store: a flat ellipse on top, then one stroke down a side, round the bottom and up. */
export function cylinder(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  const capRy = Math.max(6, h * 0.12);
  const cap = ellipse(x + w / 2, y + capRy, w / 2, capRy, hd)[0]!;
  const body: Pt[] = [{ x, y: y + capRy }];
  const n = 16;
  for (let k = 0; k <= n; k += 1) {
    const a = Math.PI - (k / n) * Math.PI;
    body.push({ x: x + w / 2 + Math.cos(a) * (w / 2), y: y + h - capRy + Math.sin(a) * capRy });
  }
  body.push({ x: x + w, y: y + capRy });
  return [cap, humanize(body, hd)];
}

/** A Queue's tube on its side: the cap at the right end. */
export function tube(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  const capRx = Math.max(6, w * 0.1);
  const cap = ellipse(x + w - capRx, y + h / 2, capRx, h / 2, hd)[0]!;
  const body: Pt[] = [{ x: x + w - capRx, y }];
  body.push({ x: x + capRx, y });
  const n = 12;
  for (let k = 0; k <= n; k += 1) {
    const a = -Math.PI / 2 - (k / n) * Math.PI;
    body.push({ x: x + capRx + Math.cos(a) * capRx, y: y + h / 2 + Math.sin(a) * (h / 2) });
  }
  body.push({ x: x + w - capRx, y: y + h });
  return [cap, humanize(body, hd)];
}

export function stickFigure(cx: number, top: number, size: number, hd: Hand): Pt[][] {
  const r = size * 0.14;
  const head = ellipse(cx, top + r, r, r, hd)[0]!;
  const neck = top + 2 * r;
  const hip = top + size * 0.62;
  return [
    head,
    humanize([{ x: cx, y: neck }, { x: cx, y: hip }], hd),
    humanize([{ x: cx - size * 0.3, y: neck + size * 0.12 }, { x: cx + size * 0.3, y: neck + size * 0.12 }], hd),
    humanize([{ x: cx - size * 0.22, y: top + size }, { x: cx, y: hip }, { x: cx + size * 0.22, y: top + size }], hd),
  ];
}

/** A dense back-and-forth scribble filling a box — colouring in, not a shape. */
export function scribble(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  const points: Pt[] = [];
  const passes = 9;
  for (let k = 0; k <= passes; k += 1) {
    points.push({ x: x + (k % 2 === 0 ? 0 : w), y: y + (k / passes) * h + (hd.random() - 0.5) * 6 });
  }
  return [humanize(points, hd)];
}

export function zigzag(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  const points: Pt[] = [];
  for (let k = 0; k <= 8; k += 1) points.push({ x: x + (k / 8) * w, y: y + (k % 2 === 0 ? 0 : h) });
  return [humanize(points, hd)];
}

/** A rectangle missing its fourth side: still being drawn, not a box yet. */
export function openBox(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  return [humanize([{ x, y }, { x, y: y + h }, { x: x + w, y: y + h }, { x: x + w, y }], hd)];
}

export function triangle(x: number, y: number, w: number, h: number, hd: Hand): Pt[][] {
  return [humanize([{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x: x + w / 2, y }], hd)];
}

export function spiral(cx: number, cy: number, r: number, hd: Hand): Pt[][] {
  const points: Pt[] = [];
  for (let k = 0; k <= 80; k += 1) {
    const a = (k / 80) * Math.PI * 6;
    const rr = (k / 80) * r;
    points.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  return [humanize(points, hd)];
}

/** Cursive-looking loops along a line — handwriting, not a figure. */
export function handwriting(x: number, y: number, w: number, hd: Hand): Pt[][] {
  const points: Pt[] = [];
  for (let k = 0; k <= 60; k += 1) {
    const t = k / 60;
    points.push({ x: x + t * w + Math.sin(t * 40) * 6, y: y + Math.cos(t * 40) * 9 - Math.sin(t * 7) * 4 });
  }
  return [humanize(points, hd)];
}

export function checkmark(x: number, y: number, size: number, hd: Hand): Pt[][] {
  return [humanize([{ x, y: y + size * 0.55 }, { x: x + size * 0.35, y: y + size }, { x: x + size, y }], hd)];
}
