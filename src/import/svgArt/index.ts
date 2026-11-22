import { normalizeAsset, STYLE_LIMITS, type ArtPaint, type ArtPath, type StyleAsset } from '../../document/style';
import { luminance } from '../../lib/colour';
import { IDENTITY, multiply, readPath, transformed, written, type Matrix, type Segment } from '../../render/style/pathData';

/**
 * An SVG picture someone chose, made into a drawing a style can keep.
 *
 * The file is untrusted, and none of it is kept. It is read by the browser's own XML parser into a
 * document that is never put on the page, walked for the shapes it draws, and what comes out is a
 * `StyleAsset`: numbers, four path commands and colours. Scripts, event handlers, links, images,
 * text, style sheets and anything that refers outside the file have nowhere to go in that form, so
 * there is nothing to strip and nothing to miss. `normalizeAsset` then checks the result like any
 * other drawing, here and again wherever it is read back.
 *
 * Main thread only: it needs `DOMParser`. The check that makes a stored drawing safe does not.
 */

/** `diagram`: painted in the shape's own colour, so it follows a recolour and light or dark. `original`: its own colours, always. */
export type SvgArtMode = 'diagram' | 'original';

export type SvgArtResult = { ok: true; asset: StyleAsset; notes: string[] } | { ok: false; message: string };

/** How much of a file is read at all. A drawing worth using as a shape is far smaller. */
export const MAX_SVG_BYTES = 262_144;
const MAX_ELEMENTS = 2_000;
const MAX_DEPTH = 32;
const MAX_USES = 200;
/** Segments read from one path before giving up: a hostile file must not be able to ask for more. */
const MAX_SEGMENTS = 6_000;

const NOT_A_PICTURE = 'This file isn’t an SVG picture.';
const TOO_DETAILED = 'This picture is too detailed to use as a shape. Simplify it and try again.';
const NOTHING_DRAWN = 'Nothing in this picture can be drawn as a shape.';
const NOTE_LEFT_OUT = 'Text, images and effects were left out.';
const NOTE_SHEET = 'Colours set in a style sheet were not read. Export it with presentation attributes to keep them.';
const NOTE_GRADIENT = 'Gradients and patterns were drawn as one colour.';

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
  pink: '#ffc0cb', brown: '#a52a2a', gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080', teal: '#008080', maroon: '#800000',
  olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', coral: '#ff7f50', salmon: '#fa8072', khaki: '#f0e68c', tan: '#d2b48c', beige: '#f5f5dc', ivory: '#fffff0', crimson: '#dc143c',
};

/** A paint as the file gave it: a colour, the page's text colour, a reference to something else, or none. */
type Read = { kind: 'none' } | { kind: 'current' } | { kind: 'colour'; hex: string; alpha: number } | { kind: 'reference'; id: string };

const hex2 = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');

function readPaint(raw: string): Read | null {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'inherit') return null;
  if (value === 'none' || value === 'transparent') return { kind: 'none' };
  if (value === 'currentcolor') return { kind: 'current' };
  const reference = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(raw.trim());
  if (reference) return { kind: 'reference', id: reference[1]! };
  if (/^#[0-9a-f]{3,4}$/.test(value)) {
    const [r, g, b, a] = [...value.slice(1)].map((digit) => digit + digit);
    return { kind: 'colour', hex: `#${r}${g}${b}`, alpha: a ? parseInt(a, 16) / 255 : 1 };
  }
  if (/^#[0-9a-f]{6}$/.test(value)) return { kind: 'colour', hex: value, alpha: 1 };
  if (/^#[0-9a-f]{8}$/.test(value)) return { kind: 'colour', hex: value.slice(0, 7), alpha: parseInt(value.slice(7), 16) / 255 };
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value);
  if (rgb) {
    const channel = (part: string) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part));
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { kind: 'colour', hex: `#${hex2(channel(rgb[1]!))}${hex2(channel(rgb[2]!))}${hex2(channel(rgb[3]!))}`, alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1 };
  }
  return NAMED[value] ? { kind: 'colour', hex: NAMED[value], alpha: 1 } : null;
}

/** What is inherited down the tree: an element draws with its own values, or its parent's. */
interface Inherited {
  fill: Read;
  stroke: Read;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  evenodd: boolean;
  hidden: boolean;
}

const START: Inherited = { fill: { kind: 'colour', hex: '#000000', alpha: 1 }, stroke: { kind: 'none' }, strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, evenodd: false, hidden: false };

/** A length without its unit: a drawing's own units are all it has. Percentages mean nothing here. */
function length(raw: string | null | undefined, fallback = 0): number {
  if (raw == null) return fallback;
  const value = parseFloat(raw);
  return Number.isFinite(value) && !raw.trim().endsWith('%') ? value : fallback;
}

function unit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = raw.trim().endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** An element's presentation: its attributes, then its own `style="…"`, which wins as it does in a browser. */
function presentation(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'display', 'visibility', 'stop-color']) {
    const value = element.getAttribute(name);
    if (value !== null) out[name] = value;
  }
  for (const part of (element.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) out[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
  }
  return out;
}

function inherit(parent: Inherited, element: Element): Inherited {
  const own = presentation(element);
  const fill = own.fill === undefined ? null : readPaint(own.fill);
  const stroke = own.stroke === undefined ? null : readPaint(own.stroke);
  return {
    fill: fill ?? parent.fill,
    stroke: stroke ?? parent.stroke,
    strokeWidth: own['stroke-width'] === undefined ? parent.strokeWidth : Math.max(0, length(own['stroke-width'], parent.strokeWidth)),
    // Opacity is not inherited, it compounds: a faint group makes everything in it fainter.
    opacity: parent.opacity * unit(own.opacity, 1),
    fillOpacity: unit(own['fill-opacity'], parent.fillOpacity),
    strokeOpacity: unit(own['stroke-opacity'], parent.strokeOpacity),
    evenodd: own['fill-rule'] === undefined ? parent.evenodd : own['fill-rule'].trim() === 'evenodd',
    hidden: parent.hidden || own.display?.trim() === 'none' || own.visibility?.trim() === 'hidden' || own.visibility?.trim() === 'collapse',
  };
}

function transformOf(raw: string | null): Matrix {
  if (!raw) return IDENTITY;
  let matrix = IDENTITY;
  for (const match of raw.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = (match[2]!.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    if (v.some((value) => !Number.isFinite(value))) continue;
    let step: Matrix = IDENTITY;
    const radians = ((v[0] ?? 0) * Math.PI) / 180;
    switch (match[1]) {
      case 'matrix':
        if (v.length === 6) step = v as Matrix;
        break;
      case 'translate':
        step = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case 'scale':
        step = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const turn: Matrix = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];
        step = v.length >= 3 ? multiply(multiply([1, 0, 0, 1, v[1]!, v[2]!], turn), [1, 0, 0, 1, -v[1]!, -v[2]!]) : turn;
        break;
      }
      case 'skewX':
        step = [1, 0, Math.tan(radians), 1, 0, 0];
        break;
      case 'skewY':
        step = [1, Math.tan(radians), 0, 1, 0, 0];
        break;
    }
    matrix = multiply(matrix, step);
  }
  return matrix;
}

/** The path data a basic shape draws, or `null` for one with no size. */
function outline(element: Element): string | null {
  const n = (name: string) => length(element.getAttribute(name));
  switch (element.localName) {
    case 'path':
      return element.getAttribute('d');
    case 'rect': {
      const w = n('width');
      const h = n('height');
      if (w <= 0 || h <= 0) return null;
      const x = n('x');
      const y = n('y');
      const hasRx = element.hasAttribute('rx');
      const hasRy = element.hasAttribute('ry');
      const rx = Math.min(w / 2, Math.max(0, hasRx ? n('rx') : hasRy ? n('ry') : 0));
      const ry = Math.min(h / 2, Math.max(0, hasRy ? n('ry') : hasRx ? n('rx') : 0));
      if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const rx = element.localName === 'circle' ? n('r') : n('rx');
      const ry = element.localName === 'circle' ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return null;
      const cx = n('cx');
      const cy = n('cy');
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const points = (element.getAttribute('points') ?? '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
      if (points.length < 4) return null;
      let d = '';
      for (let i = 0; i + 1 < points.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${points[i]} ${points[i + 1]}`;
      return element.localName === 'polygon' ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

const DRAWN = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
/** Walked into for what they hold. */
const GROUPS = new Set(['svg', 'g', 'a', 'switch']);
/** Never drawn where they stand: definitions, and things a drawing cannot keep. */
const DEFINITIONS = new Set(['defs', 'symbol', 'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'filter', 'metadata', 'title', 'desc']);
const LEFT_OUT = new Set(['text', 'tspan', 'textpath', 'image', 'foreignobject', 'script', 'animate', 'animatetransform', 'animatemotion', 'set', 'video', 'audio', 'iframe', 'canvas']);

/** One thing the picture draws, in its own coordinates. */
interface Drawn {
  segments: Segment[];
  fill: Read;
  stroke: Read;
  strokeWidth: number;
  fillAlpha: number;
  strokeAlpha: number;
  evenodd: boolean;
}

/** FNV-1a, twice with different starts: an id that is the same for the same drawing, with no library. */
function idOf(asset: Omit<StyleAsset, 'id'>): string {
  const text = JSON.stringify(asset);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x811c9dc5);
  }
  return `a${(a >>> 0).toString(36).padStart(7, '0')}${(b >>> 0).toString(36).padStart(7, '0')}`;
}

export function importSvgArt(text: string, mode: SvgArtMode = 'diagram'): SvgArtResult {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, message: NOT_A_PICTURE };
  if (text.length > MAX_SVG_BYTES) return { ok: false, message: TOO_DETAILED };
  // An entity can expand to anything, many times over. A picture needs none, so none are read.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return { ok: false, message: NOT_A_PICTURE };
  if (typeof DOMParser === 'undefined') return { ok: false, message: NOT_A_PICTURE };
  let root: Element;
  try {
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    root = parsed.documentElement;
    if (!root || root.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length > 0) return { ok: false, message: NOT_A_PICTURE };
  } catch {
    return { ok: false, message: NOT_A_PICTURE };
  }

  const notes = new Set<string>();
  const byId = new Map<string, Element>();
  let seen = 0;
  for (const element of [root, ...root.querySelectorAll('*')]) {
    seen += 1;
    if (seen > MAX_ELEMENTS) return { ok: false, message: TOO_DETAILED };
    const id = element.getAttribute('id');
    if (id && !byId.has(id)) byId.set(id, element);
    if (element.localName.toLowerCase() === 'style') notes.add(NOTE_SHEET);
  }

  /** A gradient or pattern as the one colour it starts with. */
  const resolved = (paint: Read): Read => {
    if (paint.kind !== 'reference') return paint;
    notes.add(NOTE_GRADIENT);
    const target = byId.get(paint.id);
    for (const stop of target?.querySelectorAll('stop') ?? []) {
      const colour = readPaint(presentation(stop)['stop-color'] ?? '');
      if (colour?.kind === 'colour') return colour;
    }
    return { kind: 'current' };
  };

  const drawn: Drawn[] = [];
  let uses = 0;
  let segments = 0;
  let tooMuch = false;
  const walk = (element: Element, inherited: Inherited, matrix: Matrix, depth: number, viaUse: boolean): void => {
    if (tooMuch || depth > MAX_DEPTH) return;
    const name = element.localName.toLowerCase();
    if (LEFT_OUT.has(name)) {
      notes.add(NOTE_LEFT_OUT);
      return;
    }
    // A symbol is drawn only where something uses it.
    if (DEFINITIONS.has(name) && !(viaUse && name === 'symbol')) return;
    const own = inherit(inherited, element);
    if (own.hidden) return;
    if (element.hasAttribute('filter') || element.hasAttribute('mask') || element.hasAttribute('clip-path')) notes.add(NOTE_LEFT_OUT);
    const here = multiply(matrix, transformOf(element.getAttribute('transform')));
    if (name === 'use') {
      const href = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';
      // Only something in this same file: a reference anywhere else is simply not followed.
      const target = href.startsWith('#') ? byId.get(href.slice(1)) : undefined;
      uses += 1;
      if (!target || uses > MAX_USES) return;
      const moved = multiply(here, [1, 0, 0, 1, length(element.getAttribute('x')), length(element.getAttribute('y'))]);
      walk(target, own, moved, depth + 1, true);
      return;
    }
    if (GROUPS.has(name) || name === 'symbol') {
      for (const child of element.children) walk(child, own, here, depth + 1, false);
      return;
    }
    if (!DRAWN.has(name)) return;
    const d = outline(element);
    const read = d ? readPath(d, MAX_SEGMENTS) : null;
    if (read === 'limit') {
      tooMuch = true;
      return;
    }
    if (!read) return;
    segments += read.length;
    if (segments > MAX_SEGMENTS) {
      tooMuch = true;
      return;
    }
    // A line has no inside to fill, whatever its fill says.
    const fill = name === 'line' ? ({ kind: 'none' } as Read) : resolved(own.fill);
    const stroke = resolved(own.stroke);
    const fillAlpha = own.opacity * own.fillOpacity * (fill.kind === 'colour' ? fill.alpha : 1);
    const strokeAlpha = own.opacity * own.strokeOpacity * (stroke.kind === 'colour' ? stroke.alpha : 1);
    const filled = fill.kind !== 'none' && fillAlpha > 0.01;
    const stroked = stroke.kind !== 'none' && strokeAlpha > 0.01 && own.strokeWidth > 0;
    if (!filled && !stroked) return;
    // A stroke is as wide as the element's scale makes it, which a skew or uneven scale only approximates.
    const scale = Math.sqrt(Math.abs(here[0] * here[3] - here[1] * here[2]));
    drawn.push({
      segments: transformed(read, here),
      fill: filled ? fill : { kind: 'none' },
      stroke: stroked ? stroke : { kind: 'none' },
      strokeWidth: own.strokeWidth * scale,
      fillAlpha,
      strokeAlpha,
      evenodd: own.evenodd,
    });
  };
  walk(root, START, IDENTITY, 0, false);
  if (tooMuch) return { ok: false, message: TOO_DETAILED };
  if (drawn.length === 0) return { ok: false, message: NOTHING_DRAWN };

  // The picture's own frame: its viewBox, else its stated size, else whatever it drew on.
  const viewBox = (root.getAttribute('viewBox') ?? '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number);
  let frame: { x: number; y: number; w: number; h: number } | null = null;
  if (viewBox?.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) frame = { x: viewBox[0]!, y: viewBox[1]!, w: viewBox[2]!, h: viewBox[3]! };
  else if (length(root.getAttribute('width')) > 0 && length(root.getAttribute('height')) > 0) frame = { x: 0, y: 0, w: length(root.getAttribute('width')), h: length(root.getAttribute('height')) };
  if (!frame) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of drawn) {
      for (const segment of item.segments) {
        if (segment.c === 'Z') continue;
        for (let i = 0; i + 1 < segment.p.length; i += 2) {
          minX = Math.min(minX, segment.p[i]!);
          maxX = Math.max(maxX, segment.p[i]!);
          minY = Math.min(minY, segment.p[i + 1]!);
          maxY = Math.max(maxY, segment.p[i + 1]!);
        }
      }
    }
    frame = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (!(frame.w > 0) || !(frame.h > 0) || !Number.isFinite(frame.w + frame.h + frame.x + frame.y)) return { ok: false, message: NOTHING_DRAWN };
  // Into a size where two decimals are plenty and no number is long: a tiny or a huge drawing is
  // the same drawing, so it is brought to a few hundred units across.
  const longest = Math.max(frame.w, frame.h);
  const scale = longest < 48 || longest > STYLE_LIMITS.maxArtUnits ? 240 / longest : 1;
  const place: Matrix = [scale, 0, 0, scale, -frame.x * scale, -frame.y * scale];
  const w = Math.max(1, Math.round(frame.w * scale * 100) / 100);
  const h = Math.max(1, Math.round(frame.h * scale * 100) / 100);

  // Painted in the shape's own colour, a picture of one colour is its outline; one of several keeps
  // its light and dark, as the shape's fill and its line.
  const colours = new Set<string>();
  for (const item of drawn) for (const paint of [item.fill, item.stroke]) if (paint.kind === 'colour') colours.add(paint.hex);
  const single = colours.size <= 1;
  const painted = (paint: Read, role: 'fill' | 'stroke'): ArtPaint | undefined => {
    if (paint.kind === 'none' || paint.kind === 'reference') return undefined;
    if (paint.kind === 'current') return 'line';
    if (mode === 'original') return paint.hex as ArtPaint;
    if (role === 'stroke' || single) return 'line';
    return luminance(paint.hex) > 0.6 ? 'fill' : 'line';
  };

  const paths: ArtPath[] = [];
  for (const item of drawn) {
    const fill = painted(item.fill, 'fill');
    const stroke = painted(item.stroke, 'stroke');
    if (!fill && !stroke) continue;
    const opacity = Math.round(Math.min(1, fill ? item.fillAlpha : item.strokeAlpha) * 100) / 100;
    const path: ArtPath = { d: written(transformed(item.segments, place), STYLE_LIMITS.minArtCoordinate, STYLE_LIMITS.maxArtCoordinate) };
    if (fill) path.fill = fill;
    if (stroke) {
      path.stroke = stroke;
      path.sw = Math.round(Math.min(STYLE_LIMITS.maxArtStrokeWidth, Math.max(0.1, item.strokeWidth * scale)) * 100) / 100;
    }
    if (opacity < 1) path.o = opacity;
    if (item.evenodd && fill) path.rule = 'evenodd';
    // Neighbours painted alike are one path: a picture of many small pieces is still a few paths.
    const last = paths[paths.length - 1];
    if (last && last.fill === path.fill && last.stroke === path.stroke && last.sw === path.sw && last.o === path.o && last.rule === path.rule && !stroke) last.d += path.d;
    else paths.push(path);
  }
  if (paths.length === 0) return { ok: false, message: NOTHING_DRAWN };

  const body = { w, h, paths };
  const asset = normalizeAsset({ id: idOf(body), ...body });
  // Whatever the checks refuse, they refuse for size: everything else here is already the stored form.
  if (!asset) return { ok: false, message: TOO_DETAILED };
  return { ok: true, asset, notes: [...notes] };
}
