/**
 * The open-point marker: a small tab in the margin of the sketch, drawn once for both renderers.
 *
 * Pure geometry over the display list (`render/displayList.ts`), the same way `nodes/describe.ts`
 * describes a shape: the canvas paints these shapes through `SvgSurface`, and the SVG exporter emits
 * the very same list, so a marker can never look one way on screen and another in a PNG. Nothing
 * here is interactive — the hit target, the hover preview and the popover are canvas chrome in
 * `canvas/OpenPointMarker.tsx`, and never reach an export.
 *
 * Restraint is the design. One accent (violet — the one accent nothing else on the canvas already
 * means: teal is selection, green a decision, blue a question, amber a warning, rose a failure),
 * and a distinct glyph per kind so colour is never the only signal: a wave for a tentative
 * assumption, an ellipsis for an answer still to come, a pause mark for something parked. Several
 * points on one element fold into one tab carrying their count — never a stack of chips, and never
 * one kind's glyph standing in for the others.
 *
 * Imports `document/` and `render/` only, so the exporter can use it without a store or a DOM.
 */

import type { OpenPointKind, OpenPoint, Side } from '../document/types';
import { OPEN_POINT_LABELS, kindsAmong } from '../document/openPoints';
import type { Shape } from '../render/displayList';
import { FONTS, LINE_HEIGHTS, type FontSpec } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import type { Theme } from '../render/theme/tokens';

/** The tab is 16 units square on the canvas and in exports — the size of a connector's step badge. */
export const MARKER_SIZE = 16;
/** How far an inset tab sits from a card's top and right edges. */
export const MARKER_INSET = 6;
/** Gap between a connector's label chip (or caption) and the tab beside it. */
export const MARKER_GAP = 4;

/** The count numeral, when several points share one tab. Small and heavy, like a step number. */
const COUNT_FONT: FontSpec = { stack: 'sans', size: 9, weight: 700 };

export interface MarkerContext {
  theme: Theme;
  measurer?: TextMeasurer;
}

/** The colours every marker draws with — resolved once per theme. */
export function markerPalette(theme: Theme): { fill: string; line: string } {
  return { fill: theme.edgeLabelBg, line: theme.accents.violet.chip };
}

/**
 * Where a node's tab sits, in the node's own coordinates.
 *
 * Off the top-right shoulder, just outside the shape — the one place every silhouette leaves free.
 * Inside the corner would read as a tab folded onto the page, but the cards already use their
 * corners: a service's window-chrome dots sit top-right, a note's kind tag top-left, a code card's
 * header holds its language and its Copy button. Outside, the tab touches the corner without
 * covering anything, and stays clear of the resize handle selection puts on it.
 *
 * A boundary is the exception: its corner is empty (the caption sits top-left) and a tab inside it
 * says "this area" more plainly than one floating beside a dashed line would.
 */
export function nodeMarkerOrigin(node: { type: string; width: number; height: number }): { x: number; y: number } {
  if (node.type === 'group') return { x: node.width - MARKER_SIZE - MARKER_INSET - 2, y: MARKER_INSET + 2 };
  return { x: node.width + 3, y: -MARKER_SIZE + 5 };
}

/** A rectangle something already draws beside a connector's label point, in flow units. */
export interface OccupiedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The centre of a connector's tab.
 *
 * Beside whatever the connector already says at its label point — the label chip or the relationship
 * caption — continuing in reading direction, so it never lands on the words, on the line, on a
 * condition chip stacked below them, or on the attachment row hanging off the other side. A connector
 * saying nothing there gets the tab one gap off the line on the label's own side, where the chip
 * would have been.
 */
export function edgeMarkerCenter(point: { x: number; y: number }, side: Side, occupied?: OccupiedRect): { x: number; y: number } {
  const half = MARKER_SIZE / 2;
  if (occupied) {
    const centerY = occupied.top + occupied.height / 2;
    // Words left of a vertical line read outward — the tab continues further left, never back
    // toward the line the words were placed to clear.
    if (side === 'left' || occupied.left + occupied.width <= point.x - MARKER_GAP) {
      return { x: occupied.left - MARKER_GAP - half, y: centerY };
    }
    return { x: occupied.left + occupied.width + MARKER_GAP + half, y: centerY };
  }
  const clear = 8 + half;
  switch (side) {
    case 'top':
      return { x: point.x, y: point.y - clear };
    case 'bottom':
      return { x: point.x, y: point.y + clear };
    case 'left':
      return { x: point.x - clear, y: point.y };
    case 'right':
      return { x: point.x + clear, y: point.y };
  }
}

/** The tab itself: the small rounded plate every glyph sits on. */
function tab(theme: Theme): Shape {
  const { fill, line } = markerPalette(theme);
  return { t: 'rect', x: 0.5, y: 0.5, w: MARKER_SIZE - 1, h: MARKER_SIZE - 1, r: 4, fill, stroke: { color: line, width: 1 } };
}

/** One kind's tab and glyph — a single point's marker, and the picture of that kind everywhere else. */
export function describeKindTab(kind: OpenPointKind, ctx: MarkerContext): Shape[] {
  return [tab(ctx.theme), ...glyph(kind, markerPalette(ctx.theme).line)];
}

/** The glyph for one kind, drawn inside a `MARKER_SIZE` box at the origin. */
function glyph(kind: OpenPointKind, color: string): Shape[] {
  const stroke = { color, width: 1.5, linecap: 'round' as const };
  switch (kind) {
    case 'tentative':
      // One wave: a line drawn roughly, the way a pencil marks "about here".
      return [{ t: 'path', d: 'M3.5 9.2 C5 6.6 6.6 6.6 8 8.8 S11 11.2 12.5 8.4', fill: 'none', stroke }];
    case 'awaiting':
      // An ellipsis: the answer has not arrived yet.
      return [4.4, 8, 11.6].map((cx) => ({ t: 'ellipse' as const, cx, cy: 8.5, rx: 1.2, ry: 1.2, fill: color }));
    case 'parked':
      // A pause mark: stopped on purpose, to be picked up again.
      return [
        { t: 'rect', x: 5, y: 4.5, w: 1.8, h: 7, r: 0.6, fill: color },
        { t: 'rect', x: 9.2, y: 4.5, w: 1.8, h: 7, r: 0.6, fill: color },
      ];
  }
}

/**
 * One marker for the unresolved points on an element: a single point's kind glyph, or the count
 * when there are several. Positioned by the caller (a `translate`d group in an export, `left`/`top`
 * on the canvas); this only knows the 16-unit box.
 */
export function describeMarker(points: readonly OpenPoint[], ctx: MarkerContext): Shape[] {
  if (points.length === 1) return describeKindTab(points[0]!.kind, ctx);
  const { line } = markerPalette(ctx.theme);
  const shapes: Shape[] = [tab(ctx.theme)];
  const layout = layoutText(String(points.length), {
    font: COUNT_FONT,
    maxWidth: MARKER_SIZE,
    lineHeight: COUNT_FONT.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer: ctx.measurer,
  });
  shapes.push({
    t: 'text',
    x: MARKER_SIZE / 2,
    y: MARKER_SIZE / 2 - layout.height / 2,
    layout,
    font: COUNT_FONT,
    fill: line,
    align: 'middle',
  });
  return shapes;
}

/** What a marker says out loud — its tooltip and accessible name. */
export function describeMarkerText(points: readonly OpenPoint[]): string {
  if (points.length === 1) {
    const point = points[0]!;
    return `Open point: ${OPEN_POINT_LABELS[point.kind]}${point.context ? ` — ${point.context}` : ''}`;
  }
  const kinds = kindsAmong(points).map((kind) => OPEN_POINT_LABELS[kind]);
  return `${points.length} open points: ${kinds.join(', ')}`;
}

export interface MarkerKey {
  shapes: Shape[];
  width: number;
  height: number;
}

/** Between the key's entries, and between a glyph and its word. */
const KEY_GAP = 14;
const KEY_GLYPH_GAP = 5;

/**
 * The key an exported image carries when markers appear in it: one entry per kind actually present,
 * each its glyph and its name, so a reader with no hover to reach for still knows what a wave, an
 * ellipsis or a pause mark means. Laid out in one row at the origin; the caller places it below the
 * architecture, outside the drawing itself.
 */
export function describeMarkerKey(points: readonly OpenPoint[], ctx: MarkerContext): MarkerKey | null {
  const kinds = kindsAmong(points);
  if (kinds.length === 0) return null;
  const font = FONTS.connectorCaption;
  const lineHeight = font.size * LINE_HEIGHTS.label;
  const title = layoutText('Open points', { font: FONTS.presetTag, maxWidth: 200, lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label, maxLines: 1, measurer: ctx.measurer });
  const shapes: Shape[] = [];
  let x = 0;
  shapes.push({ t: 'text', x, y: MARKER_SIZE / 2 - title.height / 2, layout: title, font: FONTS.presetTag, fill: ctx.theme.textFaint, align: 'start' });
  x += title.width + KEY_GAP;
  for (const kind of kinds) {
    shapes.push({ t: 'group', translate: { x, y: 0 }, children: describeKindTab(kind, ctx) });
    x += MARKER_SIZE + KEY_GLYPH_GAP;
    const label = layoutText(OPEN_POINT_LABELS[kind], { font, maxWidth: 200, lineHeight, maxLines: 1, measurer: ctx.measurer });
    shapes.push({ t: 'text', x, y: MARKER_SIZE / 2 - label.height / 2, layout: label, font, fill: ctx.theme.textMuted, align: 'start' });
    x += label.width + KEY_GAP;
  }
  return { shapes, width: x - KEY_GAP, height: MARKER_SIZE };
}
