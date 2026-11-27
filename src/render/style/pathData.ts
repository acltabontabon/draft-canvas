/**
 * SVG path data, read into the three kinds of segment a style's drawing is stored as.
 *
 * Whatever a path was written with (relative moves, horizontal and vertical lines, smooth and
 * quadratic curves, arcs), what comes out is absolute `M`, `L`, `C` and `Z`. A curve is a curve
 * after any stretch or turn, which is what lets a drawing be scaled by moving its numbers.
 */

export type Segment = { c: 'M' | 'L'; p: [number, number] } | { c: 'C'; p: [number, number, number, number, number, number] } | { c: 'Z' };

/** A 2×3 affine matrix, as SVG writes one: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `outer` applied after `inner`: what a child's own transform is inside its parent's. */
export function multiply(outer: Matrix, inner: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
const SEPARATOR = /[\s,]*/y;

/**
 * An elliptical arc as cubic curves, by the method in the SVG specification's implementation notes.
 * At most four curves: an arc is cut into quarter turns, each close enough to a cubic to be one.
 */
function arc(x1: number, y1: number, rx: number, ry: number, turn: number, large: boolean, sweep: boolean, x2: number, y2: number, out: Segment[]): void {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    if (x1 !== x2 || y1 !== y2) out.push({ c: 'L', p: [x2, y2] });
    return;
  }
  const phi = (turn * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const px = cos * dx + sin * dy;
  const py = -sin * dx + cos * dy;
  const reach = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (reach > 1) {
    const grow = Math.sqrt(reach);
    rx *= grow;
    ry *= grow;
  }
  const top = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
  const bottom = rx * rx * py * py + ry * ry * px * px;
  const scale = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, top / bottom));
  const cxp = (scale * rx * py) / ry;
  const cyp = (-scale * ry * px) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const value = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / length)));
    return ux * vy - uy * vx < 0 ? -value : value;
  };
  const start = angle(1, 0, (px - cxp) / rx, (py - cyp) / ry);
  let sweepAngle = angle((px - cxp) / rx, (py - cyp) / ry, (-px - cxp) / rx, (-py - cyp) / ry);
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  else if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2) - 1e-9));
  const step = sweepAngle / pieces;
  const handle = (4 / 3) * Math.tan(step / 4);
  const point = (theta: number): [number, number, number, number] => {
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    // Position, then the direction of travel at it.
    return [cx + rx * ct * cos - ry * st * sin, cy + rx * ct * sin + ry * st * cos, -rx * st * cos - ry * ct * sin, -rx * st * sin + ry * ct * cos];
  };
  let from = point(start);
  for (let i = 1; i <= pieces; i += 1) {
    const to = point(start + step * i);
    out.push({ c: 'C', p: [from[0] + handle * from[2], from[1] + handle * from[3], to[0] - handle * to[2], to[1] - handle * to[3], i === pieces ? x2 : to[0], i === pieces ? y2 : to[1]] });
    from = to;
  }
}

/** The segments `d` draws; `null` when it is not path data, `'limit'` when it draws more than `limit` of them. */
export function readPath(d: string, limit: number): Segment[] | null | 'limit' {
  // Read a character at a time, not split up front: an arc's two flags are single digits that
  // minified files run together with the number after them (`a1 1 0 011 1`).
  let at = 0;
  const skip = () => {
    SEPARATOR.lastIndex = at;
    SEPARATOR.test(d);
    at = SEPARATOR.lastIndex;
  };
  const number = (flag: boolean): number | null => {
    skip();
    if (flag) {
      const digit = d[at];
      if (digit !== '0' && digit !== '1') return null;
      at += 1;
      return digit === '1' ? 1 : 0;
    }
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(d);
    if (!match) return null;
    at = NUMBER.lastIndex;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  };
  const out: Segment[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The last control point, for the smooth commands that mirror it.
  let cubicX: number | null = null;
  let cubicY = 0;
  let quadX: number | null = null;
  let quadY = 0;
  let command = '';
  for (;;) {
    skip();
    if (at >= d.length) break;
    const letter = d[at]!;
    if (/[a-zA-Z]/.test(letter)) {
      if (ARITY[letter.toUpperCase()] === undefined) return null;
      command = letter;
      at += 1;
    } else if (command === '' || command === 'Z' || command === 'z') {
      // A number with no command to belong to, at the start or after a close.
      return null;
    }
    const upper = command.toUpperCase();
    const arity = ARITY[upper]!;
    const relative = command !== upper;
    if (arity === 0) {
      out.push({ c: 'Z' });
      x = startX;
      y = startY;
      cubicX = quadX = null;
      continue;
    }
    const v: number[] = [];
    for (let k = 0; k < arity; k += 1) {
      const value = number(upper === 'A' && (k === 3 || k === 4));
      if (value === null) return null;
      v.push(value);
    }
    const ax = (value: number) => (relative ? x + value : value);
    const ay = (value: number) => (relative ? y + value : value);
    let nextCubic: number | null = null;
    let nextCubicY = 0;
    let nextQuad: number | null = null;
    let nextQuadY = 0;
    switch (upper) {
      case 'M':
        x = ax(v[0]!);
        y = ay(v[1]!);
        startX = x;
        startY = y;
        out.push({ c: 'M', p: [x, y] });
        // Further pairs after a move are lines.
        command = relative ? 'l' : 'L';
        break;
      case 'L':
        x = ax(v[0]!);
        y = ay(v[1]!);
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'H':
        x = relative ? x + v[0]! : v[0]!;
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'V':
        y = relative ? y + v[0]! : v[0]!;
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'C': {
        const p: [number, number, number, number, number, number] = [ax(v[0]!), ay(v[1]!), ax(v[2]!), ay(v[3]!), ax(v[4]!), ay(v[5]!)];
        out.push({ c: 'C', p });
        nextCubic = p[2];
        nextCubicY = p[3];
        x = p[4];
        y = p[5];
        break;
      }
      case 'S': {
        const c1x: number = cubicX === null ? x : 2 * x - cubicX;
        const c1y: number = cubicX === null ? y : 2 * y - cubicY;
        const p: [number, number, number, number, number, number] = [c1x, c1y, ax(v[0]!), ay(v[1]!), ax(v[2]!), ay(v[3]!)];
        out.push({ c: 'C', p });
        nextCubic = p[2];
        nextCubicY = p[3];
        x = p[4];
        y = p[5];
        break;
      }
      case 'Q':
      case 'T': {
        const qx: number = upper === 'Q' ? ax(v[0]!) : quadX === null ? x : 2 * x - quadX;
        const qy: number = upper === 'Q' ? ay(v[1]!) : quadX === null ? y : 2 * y - quadY;
        const ex = upper === 'Q' ? ax(v[2]!) : ax(v[0]!);
        const ey = upper === 'Q' ? ay(v[3]!) : ay(v[1]!);
        // A quadratic curve as the cubic that draws the same line.
        out.push({ c: 'C', p: [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey] });
        nextQuad = qx;
        nextQuadY = qy;
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const ex = ax(v[5]!);
        const ey = ay(v[6]!);
        arc(x, y, v[0]!, v[1]!, v[2]!, v[3]! !== 0, v[4]! !== 0, ex, ey, out);
        x = ex;
        y = ey;
        break;
      }
      default:
        return null;
    }
    cubicX = nextCubic;
    cubicY = nextCubicY;
    quadX = nextQuad;
    quadY = nextQuadY;
    if (out.length > limit) return 'limit';
  }
  return out.length > 0 && out[0]!.c === 'M' ? out : null;
}

/** `segments` with every point put through `matrix`. */
export function transformed(segments: readonly Segment[], matrix: Matrix): Segment[] {
  const at = (x: number, y: number): [number, number] => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  return segments.map((segment): Segment => {
    if (segment.c === 'Z') return segment;
    if (segment.c === 'C') {
      const [a, b] = at(segment.p[0], segment.p[1]);
      const [c, d] = at(segment.p[2], segment.p[3]);
      const [e, f] = at(segment.p[4], segment.p[5]);
      return { c: 'C', p: [a, b, c, d, e, f] };
    }
    return { c: segment.c, p: at(segment.p[0], segment.p[1]) };
  });
}

/**
 * The stored form: a command letter, then its numbers a space apart, to two decimals, each held to
 * `[min, max]` of its own axis: `x` across, `y` down.
 */
export function written(segments: readonly Segment[], x: readonly [number, number], y: readonly [number, number] = x): string {
  const n = (value: number, [min, max]: readonly [number, number]) => String(Math.round(Math.min(max, Math.max(min, value)) * 100) / 100 || 0);
  let out = '';
  for (const segment of segments) out += segment.c === 'Z' ? 'Z' : `${segment.c}${segment.p.map((value, index) => n(value, index % 2 === 0 ? x : y)).join(' ')}`;
  return out;
}
