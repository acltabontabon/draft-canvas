/**
 * Handwritten ink in a room: reading it, repairing it from a file, and the few pure edits it takes.
 *
 * Ink is annotation laid over a room's shapes (`DraftInk`). Like every operation in this folder,
 * these return a new document that shares everything they did not touch, and hand back the same
 * document when nothing changed — so a no-op never becomes an undo step. A room with no strokes has
 * no `ink` field at all (never `[]`): absence is how every file before v28 reads, and keeping one
 * spelling of "none" is what lets the collaboration diff and the history compare copies cheaply.
 */
import { clamp, isFiniteNumber } from '../lib/math';
import { isRecord } from '../lib/isRecord';
import { LIMITS } from './limits';
import { INK_COLORS, INK_TOOLS, type DraftDocument, type DraftInk, type InkColor, type InkTool } from './types';

export const INK_ID_PREFIX = 'k';

const EMPTY: readonly DraftInk[] = Object.freeze([]);

/** A room's strokes, oldest first (drawing order is paint order). */
export function inkOf(graph: { ink?: DraftInk[] }): readonly DraftInk[] {
  return graph.ink ?? EMPTY;
}

/** `doc` holding exactly `ink`, with the field dropped when there is none. */
export function withInk<T extends { ink?: DraftInk[] }>(doc: T, ink: readonly DraftInk[]): T {
  if (ink.length === 0) {
    if (doc.ink === undefined) return doc;
    const { ink: _dropped, ...rest } = doc;
    return rest as T;
  }
  return { ...doc, ink: ink as DraftInk[] };
}

/** Rounds a coordinate to the tenth of a unit strokes are stored at. */
export function inkRound(value: number): number {
  return Math.round(value * 10) / 10;
}

export function addInk(doc: DraftDocument, strokes: readonly DraftInk[]): DraftDocument {
  if (strokes.length === 0) return doc;
  const existing = inkOf(doc);
  const known = new Set(existing.map((stroke) => stroke.id));
  const fresh = strokes.filter((stroke) => !known.has(stroke.id));
  if (fresh.length === 0) return doc;
  return withInk(doc, [...existing, ...fresh]);
}

export function removeInk(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const gone = new Set(ids);
  if (gone.size === 0) return doc;
  const existing = inkOf(doc);
  const kept = existing.filter((stroke) => !gone.has(stroke.id));
  return kept.length === existing.length ? doc : withInk(doc, kept);
}

/** Moves the named strokes by `dx`/`dy` — two numbers per stroke, never its points. */
export function translateInk(doc: DraftDocument, ids: Iterable<string>, dx: number, dy: number): DraftDocument {
  const moving = new Set(ids);
  if (moving.size === 0 || (dx === 0 && dy === 0)) return doc;
  let changed = false;
  const ink = inkOf(doc).map((stroke) => {
    if (!moving.has(stroke.id)) return stroke;
    const x = clampCoordinate(inkRound(stroke.x + dx));
    const y = clampCoordinate(inkRound(stroke.y + dy));
    if (x === stroke.x && y === stroke.y) return stroke;
    changed = true;
    return { ...stroke, x, y };
  });
  return changed ? withInk(doc, ink) : doc;
}

export interface InkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boundsCache = new WeakMap<DraftInk, InkBox>();

/** The box a stroke's centre line spans, in room coordinates — not including its width. */
export function inkBounds(stroke: DraftInk): InkBox {
  const cached = boundsCache.get(stroke);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const { points } = stroke;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const px = points[i]!;
    const py = points[i + 1]!;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const box = Number.isFinite(minX)
    ? { x: stroke.x + minX, y: stroke.y + minY, width: maxX - minX, height: maxY - minY }
    : { x: stroke.x, y: stroke.y, width: 0, height: 0 };
  boundsCache.set(stroke, box);
  return box;
}

/** A stroke's box grown by half its width — what it actually covers on the canvas. */
export function inkPaintBounds(stroke: DraftInk): InkBox {
  const box = inkBounds(stroke);
  const half = stroke.size / 2;
  return { x: box.x - half, y: box.y - half, width: box.width + stroke.size, height: box.height + stroke.size };
}

/** The union of several strokes' paint bounds, or `null` for none. */
export function inkUnionBounds(strokes: readonly DraftInk[]): InkBox | null {
  if (strokes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const box = inkPaintBounds(stroke);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A stroke's points in room coordinates, as `[x, y]` pairs. */
export function inkAbsolutePoints(stroke: DraftInk): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < stroke.points.length; i += 2) out.push({ x: stroke.x + stroke.points[i]!, y: stroke.y + stroke.points[i + 1]! });
  return out;
}

/** Counts strokes across a file's rooms — what `LIMITS.maxInkStrokes` is spent against. */
export function inkCount(graphs: Iterable<{ ink?: DraftInk[] }>): number {
  let count = 0;
  for (const graph of graphs) count += graph.ink?.length ?? 0;
  return count;
}

/* ------------------------------------------------------------- reading -- */

function clampCoordinate(value: number): number {
  return clamp(value, -LIMITS.maxCoordinate, LIMITS.maxCoordinate);
}

const OFFSET_LIMIT = 100_000;

/**
 * A stroke read from untrusted input (a file, the clipboard, a collaborator), repaired where the
 * repair is unambiguous: a size out of range is clamped, a pressure list that does not match its
 * points is dropped (the line draws evenly instead), an over-long stroke keeps its first points.
 * `null` for anything that is not a stroke at all — no id, an unknown tool, no readable points.
 * The id is checked by the caller, which knows what else in the file is already using it.
 */
export function parseInkStroke(raw: unknown, id: string): DraftInk | null {
  if (!isRecord(raw)) return null;
  const tool = typeof raw.tool === 'string' && (INK_TOOLS as readonly string[]).includes(raw.tool) ? (raw.tool as InkTool) : null;
  if (!tool) return null;
  const color: InkColor =
    typeof raw.color === 'string' && (INK_COLORS as readonly string[]).includes(raw.color)
      ? (raw.color as InkColor)
      : tool === 'highlighter'
        ? 'yellow'
        : 'graphite';
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !Array.isArray(raw.points)) return null;
  const pairs = Math.min(Math.floor(raw.points.length / 2), LIMITS.maxInkPoints);
  if (pairs === 0) return null;
  const points: number[] = new Array(pairs * 2);
  for (let i = 0; i < pairs * 2; i += 1) {
    const value = raw.points[i];
    if (!isFiniteNumber(value)) return null;
    points[i] = inkRound(clamp(value, -OFFSET_LIMIT, OFFSET_LIMIT));
  }
  const size = isFiniteNumber(raw.size) ? clamp(raw.size, LIMITS.minInkSize, LIMITS.maxInkSize) : tool === 'highlighter' ? 18 : 3;
  const stroke: DraftInk = {
    id,
    tool,
    color,
    size: Math.round(size * 100) / 100,
    x: inkRound(clampCoordinate(raw.x)),
    y: inkRound(clampCoordinate(raw.y)),
    points,
  };
  if (Array.isArray(raw.pressure) && raw.pressure.length >= pairs) {
    const pressure: number[] = new Array(pairs);
    let readable = true;
    for (let i = 0; i < pairs; i += 1) {
      const value = raw.pressure[i];
      if (!isFiniteNumber(value)) {
        readable = false;
        break;
      }
      pressure[i] = Math.round(clamp(value, 0, 100));
    }
    if (readable) stroke.pressure = pressure;
  }
  return stroke;
}
