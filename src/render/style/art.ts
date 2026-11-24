import { ACCENT_ROLES, type AccentRole, type ArtPaint, type StyleAsset, type StyleFit } from '../../document/style';
import type { Accent } from '../../document/types';
import { Lru } from '../../lib/lru';
import type { PathShape, Shape } from '../displayList';
import type { AccentPalette, Theme } from '../theme/tokens';
import { readPath } from './pathData';

/**
 * A style's own drawing, turned into the display list a shape is drawn from.
 *
 * A drawing is kept as plain path data in its own units (`StyleAsset`). Here it is placed in a box
 * on a shape by moving and scaling the numbers themselves, so what comes out is ordinary paths:
 * the canvas, the export and every preview draw it with what they already have, and nothing about
 * a drawing can reach a renderer except coordinates and colours.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** `d` with every point moved to `(ox + x * sx, oy + y * sy)`. The stored form only: `M`, `L`, `C`, `Z`. */
function placed(d: string, ox: number, oy: number, sx: number, sy: number): string {
  let out = '';
  let at = 0;
  while (at < d.length) {
    const command = d[at]!;
    let end = at + 1;
    while (end < d.length && d.charCodeAt(end) < 65) end += 1;
    out += command;
    if (end > at + 1) {
      const numbers = d.slice(at + 1, end).split(' ');
      for (let i = 0; i < numbers.length; i += 1) {
        const value = Number(numbers[i]);
        out += `${i === 0 ? '' : ' '}${round(i % 2 === 0 ? ox + value * sx : oy + value * sy)}`;
      }
    }
    at = end;
  }
  return out;
}

/** Placed paths are remembered: a drawing is laid out once per box, not once per frame. */
const PLACED = new Lru<string, string[]>(600);

function paint(value: ArtPaint | undefined, palette: AccentPalette, theme: Theme): string | undefined {
  if (value === undefined) return undefined;
  if (value[0] === '#') return value;
  if (value === 'canvas') return theme.canvas;
  if ((ACCENT_ROLES as readonly string[]).includes(value)) return palette[value as AccentRole];
  const [accent, role] = value.split(':') as [Accent, AccentRole];
  return theme.accents[accent]?.[role];
}

/**
 * `asset` drawn in `box`. `contain` keeps its proportions and centres it; `stretch` fills the box.
 * `palette` is the shape's own colour, so a drawing painted by role follows a recolour and the theme.
 */
export function artShapes(asset: StyleAsset, box: Box, fit: StyleFit, palette: AccentPalette, theme: Theme): Shape[] {
  let sx = box.w / asset.w;
  let sy = box.h / asset.h;
  let ox = box.x;
  let oy = box.y;
  if (fit === 'contain') {
    const scale = Math.min(sx, sy);
    ox += (box.w - asset.w * scale) / 2;
    oy += (box.h - asset.h * scale) / 2;
    sx = scale;
    sy = scale;
  }
  const key = `${asset.id}|${round(ox)}|${round(oy)}|${round(sx * 1000)}|${round(sy * 1000)}`;
  const paths = PLACED.getOrCreate(key, () => asset.paths.map((path) => placed(path.d, ox, oy, sx, sy)));
  // A line drawn in the drawing's own units is as heavy, beside the drawing, at any size.
  const pen = Math.sqrt(Math.abs(sx * sy));
  return asset.paths.map((path, index): PathShape => {
    const fill = paint(path.fill, palette, theme);
    const stroke = paint(path.stroke, palette, theme);
    return {
      t: 'path',
      d: paths[index]!,
      ...(fill ? { fill } : {}),
      ...(stroke ? { stroke: { color: stroke, width: round(Math.max(0.5, (path.sw ?? 1.5) * pen)), linecap: 'round' } } : {}),
      ...(path.o !== undefined ? { opacity: path.o } : {}),
      ...(path.rule ? { fillRule: path.rule } : {}),
    };
  });
}

/* ------------------------------------------------------- where it goes -- */

/** Every point a path draws through or is pulled toward: enough to box it in, arcs included. */
function pathPoints(d: string, visit: (x: number, y: number) => void): void {
  const segments = readPath(d, 20_000);
  if (!segments || segments === 'limit') return;
  for (const segment of segments) {
    if (segment.c === 'Z') continue;
    for (let i = 0; i + 1 < segment.p.length; i += 2) visit(segment.p[i]!, segment.p[i + 1]!);
  }
}

/**
 * The box a shape's own drawing takes up: everything it drew that is not words. `null` when it
 * drew nothing but words.
 *
 * Read from the drawing itself, so a style's drawing lands exactly where the built-in one was,
 * for every kind of shape, without anything having to say where that is twice.
 */
export function drawnBounds(shapes: readonly Shape[]): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const walk = (list: readonly Shape[], scale: number, tx: number, ty: number) => {
    for (const shape of list) {
      if (shape.t === 'rect') {
        add(tx + shape.x * scale, ty + shape.y * scale);
        add(tx + (shape.x + shape.w) * scale, ty + (shape.y + shape.h) * scale);
      } else if (shape.t === 'ellipse') {
        add(tx + (shape.cx - shape.rx) * scale, ty + (shape.cy - shape.ry) * scale);
        add(tx + (shape.cx + shape.rx) * scale, ty + (shape.cy + shape.ry) * scale);
      } else if (shape.t === 'path') {
        pathPoints(shape.d, (x, y) => add(tx + x * scale, ty + y * scale));
      } else if (shape.t === 'group') {
        const inner = shape.scale ?? 1;
        walk(shape.children, scale * inner, tx + (shape.translate?.x ?? 0) * scale, ty + (shape.translate?.y ?? 0) * scale);
      }
    }
  };
  walk(shapes, 1, 0, 0);
  if (!Number.isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** A shape's words: what stays when a style's drawing replaces everything else it drew. */
export function isWords(shape: Shape): boolean {
  return shape.t === 'text' || shape.t === 'rich' || shape.t === 'code';
}
