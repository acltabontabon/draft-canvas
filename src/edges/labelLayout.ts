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

/**
 * A connector's label, and its response label, laid out once for both renderers — the canvas chip
 * and the exporter draw exactly these lines, so a long label wraps and ellipsizes identically in
 * both instead of running across the canvas on one line that the export then cuts.
 */
export function layoutEdgeLabel(text: string, measurer?: TextMeasurer): TextLayout {
  return layoutText(text, {
    font: FONTS.edgeLabel,
    maxWidth: EDGE_LABEL_MAX_WIDTH,
    lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
    maxLines: 2,
    measurer,
  });
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
