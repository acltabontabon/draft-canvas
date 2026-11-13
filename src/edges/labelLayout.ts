import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText, type TextLayout } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';

/** A label chip's padding around its text. Shared by the canvas chip (its CSS padding) and the
 *  exporter, and by both placements: a chip sits `LABEL_LINE_GAP` from its line *less* this, so it
 *  is the text — the same edge a relationship caption is placed by — that clears the line by
 *  `LABEL_LINE_GAP`, not the chip's own edge. */
export const LABEL_PADDING_X = 6;
export const LABEL_PADDING_Y = 3;

/** A connector label's widest line before it wraps, in canvas units. */
const EDGE_LABEL_MAX_WIDTH = 220;
export const RECOVERY_LABEL_GAP = 2;

/** A recovery's business name and concrete operation each get one line, so a long name cannot
 * push the operation off the arrow. Shared by canvas and SVG export. */
export function layoutRecoveryLabel(name: string, operation: string, measurer?: TextMeasurer) {
  const primary = layoutText(name, {
    font: FONTS.recoveryName,
    maxWidth: 190,
    lineHeight: FONTS.recoveryName.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer,
  });
  const secondary = layoutText(operation, {
    font: FONTS.connectorCaption,
    maxWidth: 210,
    lineHeight: FONTS.connectorCaption.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer,
  });
  return {
    primary,
    secondary,
    width: Math.max(primary.width, secondary.width),
    height: primary.height + RECOVERY_LABEL_GAP + secondary.height,
  };
}

/**
 * A connector's label, and its response label, laid out once for both renderers — the canvas chip
 * and the exporter draw exactly these lines, so a long label wraps and ellipsizes identically in
 * both instead of running across the canvas on one line that the export then cuts.
 */
export function layoutEdgeLabel(text: string, measurer?: TextMeasurer, room?: number): TextLayout {
  return layoutText(text, {
    font: FONTS.edgeLabel,
    maxWidth: fitRoom(room, LABEL_PADDING_X * 2, EDGE_LABEL_MAX_WIDTH),
    lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
    maxLines: 2,
    measurer,
  });
}

/** A relationship caption's widest line: one line, then an ellipsis. */
const CAPTION_MAX_WIDTH = 120;
/** The narrowest a label or caption is laid out to fit a short line — any less and only the ellipsis
 *  would be left to read; the full text is always in its tooltip. */
const MIN_FIT_WIDTH = 56;

/** A text width for the room a connector's route leaves at its label point (`RoutedEdge.labelRoom`),
 *  less `chrome` (a chip's padding), between `MIN_FIT_WIDTH` and `max`. No room given: `max`. */
function fitRoom(room: number | undefined, chrome: number, max: number): number {
  if (room === undefined) return max;
  return Math.max(MIN_FIT_WIDTH, Math.min(max, room - chrome));
}

/**
 * A connector's relationship caption ("sends command to"), laid out once for both renderers: one
 * line, no wider than its line leaves room for before a shape or the arrowhead, then an ellipsis —
 * the canvas puts the whole caption in a tooltip.
 */
export function layoutConnectorCaption(text: string, measurer?: TextMeasurer, room?: number): TextLayout {
  return layoutText(text, {
    font: FONTS.connectorCaption,
    maxWidth: fitRoom(room, 0, CAPTION_MAX_WIDTH),
    lineHeight: FONTS.connectorCaption.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer,
  });
}

/** How far past its room a caption may reach before it is left out: a couple of pixels into the
 *  arrowhead's own clearance at each end, which no eye reads as touching. */
const CAPTION_OVERHANG = 8;

/**
 * The caption both renderers draw, or `null` when its line has no room for it.
 *
 * A caption is fitted to the room its run leaves before a shape or the arrowhead, but never
 * narrower than `MIN_FIT_WIDTH`. On a run shorter than that the fitted caption still reached into
 * the shapes at both ends, and since shapes paint over connectors it showed as a few clipped
 * letters under each one. A caption that cannot be read is left out: the line's own style and its
 * inspector still say what the relationship is, and the caption returns as soon as the two shapes
 * are far enough apart to hold it.
 */
export function fittedConnectorCaption(text: string, measurer?: TextMeasurer, room?: number): TextLayout | null {
  const layout = layoutConnectorCaption(text, measurer, room);
  return room !== undefined && layout.width > room + CAPTION_OVERHANG ? null : layout;
}

/** Measured chip bounds, including the same padding used by both renderers. */
export function edgeLabelSize(text: string): { width: number; height: number } {
  const layout = layoutEdgeLabel(text);
  return { width: layout.width + LABEL_PADDING_X * 2, height: layout.height + LABEL_PADDING_Y * 2 };
}

/** The quieter reply label: one line, same width. */
export function layoutEdgeResponse(text: string, measurer?: TextMeasurer): TextLayout {
  return layoutText(text, {
    font: FONTS.edgeLabel,
    maxWidth: EDGE_LABEL_MAX_WIDTH,
    lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer,
  });
}
