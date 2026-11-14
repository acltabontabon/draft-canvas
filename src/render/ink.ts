/**
 * How a handwritten stroke is drawn — one description shared by the canvas (`canvas/InkLayer.tsx`)
 * and every image export (`render/svg/document.ts`), so a sketch exports exactly as it looks.
 *
 * A stroke with no pressure (a mouse, a finger, a highlighter) is its smoothed centre line, stroked
 * at an even width with round ends: crisp, cheap, and an ordinary path in any SVG tool. A stylus
 * stroke with pressure is an outline that swells and thins with it, filled. Both are smoothed with
 * quadratic curves through the midpoints of the stored points — the stored points stay exactly as
 * drawn, only the drawing of them is soft.
 */
import type { DraftInk, InkColor, InkTool } from '../document/types';
import type { ThemeName } from './theme/tokens';

/** Marker colours, not the diagram's quiet accents: annotation is meant to stand out from it. */
const PALETTE: Record<ThemeName, Record<InkColor, string>> = {
  dark: { graphite: '#e8ebf0', red: '#ff6b6b', blue: '#5ea9ff', green: '#57cc78', yellow: '#ffd43b' },
  light: { graphite: '#1f2328', red: '#e03131', blue: '#1c6fd1', green: '#2b9a43', yellow: '#f5b800' },
};

/** How strongly a highlighter covers what is under it. */
const HIGHLIGHTER_OPACITY: Record<ThemeName, number> = { dark: 0.32, light: 0.38 };

export function inkColor(color: InkColor, theme: ThemeName): string {
  return PALETTE[theme][color];
}

export interface InkPaint {
  d: string;
  /** `fill` paints `d` as an outline (pressure); `stroke` strokes it at `width`. */
  mode: 'fill' | 'stroke';
  width: number;
  color: string;
  opacity: number;
  /** A highlighter multiplies on a light canvas, so the words under it stay dark. */
  blend?: 'multiply';
}

/** Nominal widths per size, in screen pixels at the moment of drawing. */
export const INK_SIZES: Record<InkTool, Record<'s' | 'm' | 'l', number>> = {
  pen: { s: 2, m: 3.5, l: 6 },
  highlighter: { s: 12, m: 20, l: 30 },
};

const pathCache = new WeakMap<number[], { centre: string; outline?: { pressure: number[]; size: number; d: string } }>();

/** The paint for one stroke, in the stroke's own coordinates (offset by its `x`/`y` when placed). */
export function inkPaint(stroke: DraftInk, theme: ThemeName): InkPaint {
  const color = inkColor(stroke.color, theme);
  if (stroke.tool === 'highlighter') {
    return {
      d: centreLine(stroke.points),
      mode: 'stroke',
      width: stroke.size,
      color,
      opacity: HIGHLIGHTER_OPACITY[theme],
      ...(theme === 'light' ? { blend: 'multiply' as const } : {}),
    };
  }
  if (stroke.pressure && stroke.points.length >= 4) {
    return { d: outline(stroke.points, stroke.pressure, stroke.size), mode: 'fill', width: 0, color, opacity: 1 };
  }
  return { d: centreLine(stroke.points), mode: 'stroke', width: stroke.size, color, opacity: 1 };
}

const fmt = (value: number) => (Math.round(value * 10) / 10).toString();

/** A smooth path through flattened points: straight to the first midpoint, curves through the rest. */
export function centreLine(points: readonly number[]): string {
  const cached = pathCache.get(points as number[]);
  if (cached) return cached.centre;
  const centre = buildCentreLine(points);
  pathCache.set(points as number[], { centre });
  return centre;
}

function buildCentreLine(points: readonly number[]): string {
  const n = Math.floor(points.length / 2);
  if (n === 0) return '';
  const x = (i: number) => points[i * 2]!;
  const y = (i: number) => points[i * 2 + 1]!;
  // A dot: a zero-length line still paints its round caps.
  if (n === 1) return `M${fmt(x(0))} ${fmt(y(0))}l0 0.01`;
  if (n === 2) return `M${fmt(x(0))} ${fmt(y(0))}L${fmt(x(1))} ${fmt(y(1))}`;
  let d = `M${fmt(x(0))} ${fmt(y(0))}L${fmt((x(0) + x(1)) / 2)} ${fmt((y(0) + y(1)) / 2)}`;
  for (let i = 1; i < n - 1; i += 1) {
    d += `Q${fmt(x(i))} ${fmt(y(i))} ${fmt((x(i) + x(i + 1)) / 2)} ${fmt((y(i) + y(i + 1)) / 2)}`;
  }
  d += `L${fmt(x(n - 1))} ${fmt(y(n - 1))}`;
  return d;
}

/** Width at full pressure × this, for pressure 0..100: never vanishing, full by a firm press. */
function pressureFactor(pressure: number): number {
  return 0.32 + 0.68 * Math.min(1, (pressure / 100) * 1.5);
}

/** A pressure-sensitive stroke as a closed outline: left side out, a round cap, right side back. */
export function outline(points: readonly number[], pressure: readonly number[], size: number): string {
  const cached = pathCache.get(points as number[]);
  if (cached?.outline && cached.outline.pressure === pressure && cached.outline.size === size) return cached.outline.d;
  const d = buildOutline(points, pressure, size);
  pathCache.set(points as number[], { centre: cached?.centre ?? buildCentreLine(points), outline: { pressure: pressure as number[], size, d } });
  return d;
}

function buildOutline(points: readonly number[], pressure: readonly number[], size: number): string {
  const n = Math.floor(points.length / 2);
  const px = (i: number) => points[i * 2]!;
  const py = (i: number) => points[i * 2 + 1]!;
  // Smoothed half-widths, so one noisy pressure sample doesn't notch the line.
  const half: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = pressure[Math.max(0, i - 1)] ?? 50;
    const b = pressure[i] ?? 50;
    const c = pressure[Math.min(n - 1, i + 1)] ?? 50;
    half.push((size * pressureFactor((a + 2 * b + c) / 4)) / 2);
  }
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(n - 1, i + 1);
    let tx = px(next) - px(prev);
    let ty = py(next) - py(prev);
    const length = Math.hypot(tx, ty) || 1;
    tx /= length;
    ty /= length;
    const w = half[i]!;
    left.push([px(i) - ty * w, py(i) + tx * w]);
    right.push([px(i) + ty * w, py(i) - tx * w]);
  }
  const side = (pts: Array<[number, number]>, first: boolean) => {
    let d = first ? `M${fmt(pts[0]![0])} ${fmt(pts[0]![1])}` : `L${fmt(pts[0]![0])} ${fmt(pts[0]![1])}`;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const [x, y] = pts[i]!;
      const [nx, ny] = pts[i + 1]!;
      d += `Q${fmt(x)} ${fmt(y)} ${fmt((x + nx) / 2)} ${fmt((y + ny) / 2)}`;
    }
    const last = pts[pts.length - 1]!;
    return d + `L${fmt(last[0])} ${fmt(last[1])}`;
  };
  const endCap = half[n - 1]!;
  const startCap = half[0]!;
  const back = right.slice().reverse();
  return (
    side(left, true) +
    `A${fmt(endCap)} ${fmt(endCap)} 0 0 0 ${fmt(back[0]![0])} ${fmt(back[0]![1])}` +
    side(back, false).replace(/^L[^QAL]*/, '') +
    `A${fmt(startCap)} ${fmt(startCap)} 0 0 0 ${fmt(left[0]![0])} ${fmt(left[0]![1])}Z`
  );
}
