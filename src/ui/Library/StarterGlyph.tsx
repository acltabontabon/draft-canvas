import { memo, type CSSProperties } from 'react';
import { Mark } from './Fingerprint';
import type { ShapeBox } from './shapeLayout';
import { GLYPH_HEIGHT, GLYPH_WIDTH, type StarterShape } from './starterShapes';

/** Air between a connector's end and the box it touches — the canvas never lets them kiss either. */
const GAP = 1.5;
const CORNER = 2.5;
const ARROW = 2.6;

type Point = [x: number, y: number];

interface Route {
  d: string;
  end: Point;
  /** Direction of travel on the last segment, for the arrowhead. */
  heading: Point;
}

/**
 * Connects two boxes the way the canvas does: out of the facing sides, orthogonally, with one
 * step in the middle when they don't line up — never a diagonal. Nothing is drawn between boxes
 * that overlap on both axes (a node inside its own boundary), since there is no side to leave by.
 */
function route(a: ShapeBox, b: ShapeBox): Route | null {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const gapX = Math.abs(dx) - (a.w + b.w) / 2;
  const gapY = Math.abs(dy) - (a.h + b.h) / 2;
  if (gapX <= GAP * 2 && gapY <= GAP * 2) return null;

  if (gapX >= gapY) {
    const sx = Math.sign(dx);
    const start: Point = [a.cx + sx * (a.w / 2 + GAP), a.cy];
    const end: Point = [b.cx - sx * (b.w / 2 + GAP), b.cy];
    const mid = (start[0] + end[0]) / 2;
    return { d: orthogonal([start, [mid, start[1]], [mid, end[1]], end]), end, heading: [sx, 0] };
  }
  const sy = Math.sign(dy);
  const start: Point = [a.cx, a.cy + sy * (a.h / 2 + GAP)];
  const end: Point = [b.cx, b.cy - sy * (b.h / 2 + GAP)];
  const mid = (start[1] + end[1]) / 2;
  return { d: orthogonal([start, [start[0], mid], [end[0], mid], end]), end, heading: [0, sy] };
}

/** A polyline with its corners rounded; a step too small to see is straightened out. */
function orthogonal(points: Point[]): string {
  const kept = points.filter((_, i) => {
    if (i === 0 || i === points.length - 1) return true;
    const prev = points[i - 1]!;
    const next = points[i + 1]!;
    const straight = Math.abs(prev[0] - next[0]) < 0.4 || Math.abs(prev[1] - next[1]) < 0.4;
    return !straight;
  });
  let d = `M${fmt(kept[0]!)}`;
  for (let i = 1; i < kept.length - 1; i += 1) {
    const prev = kept[i - 1]!;
    const corner = kept[i]!;
    const next = kept[i + 1]!;
    const r = Math.min(CORNER, dist(prev, corner) / 2, dist(corner, next) / 2);
    d += `L${fmt(toward(corner, prev, r))}Q${fmt(corner)} ${fmt(toward(corner, next, r))}`;
  }
  return `${d}L${fmt(kept[kept.length - 1]!)}`;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function toward(from: Point, to: Point, length: number): Point {
  const total = dist(from, to) || 1;
  return [from[0] + ((to[0] - from[0]) / total) * length, from[1] + ((to[1] - from[1]) / total) * length];
}

function fmt([x, y]: Point): string {
  return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
}

function arrowhead({ end, heading }: Route): string {
  const [hx, hy] = heading;
  const back: Point = [end[0] - hx * ARROW, end[1] - hy * ARROW];
  const wing = ARROW * 0.62;
  const left: Point = [back[0] - hy * wing, back[1] + hx * wing];
  const right: Point = [back[0] + hy * wing, back[1] - hx * wing];
  return `M${fmt(left)}L${fmt(end)}L${fmt(right)}`;
}

/**
 * A starter's topology at tile size: the library fingerprint's own marks (`Mark`, same kinds,
 * same classes), with connectors routed and arrowed the way the canvas draws them. Each connector
 * carries a second, normally invisible copy — the pulse — that CSS runs once along it on hover or
 * focus, delayed by its depth so the pulse reads in the order the system does.
 */
export const StarterGlyph = memo(function StarterGlyph({ starter }: { starter: StarterShape }) {
  const { shape, depths, boxes } = starter;
  const routes = shape.edges.map(([from, to], i) => {
    const a = boxes[from];
    const b = boxes[to];
    const path = a && b ? route(a, b) : null;
    return path ? { ...path, key: i, depth: depths[i] ?? 0 } : null;
  });

  return (
    <svg
      className="dc-starter-glyph"
      viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`}
      width={GLYPH_WIDTH}
      height={GLYPH_HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      {boxes.map((box, i) => (
        <Mark key={`n${i}`} {...box} />
      ))}
      {routes.map(
        (path) =>
          path && (
            <g key={`e${path.key}`} className="dc-starter-edge" style={{ '--d': path.depth } as CSSProperties}>
              <path className="dc-starter-edge-line" d={path.d} />
              <path className="dc-starter-edge-arrow" d={arrowhead(path)} />
              <path className="dc-starter-edge-pulse" d={path.d} pathLength={1} />
            </g>
          ),
      )}
    </svg>
  );
});
