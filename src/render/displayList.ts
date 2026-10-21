import type { CodeLine } from './code/highlight';
import type { CodeTheme } from './code/theme';
import type { FontSpec } from './text/fonts';
import type { TextLayout } from './text/layout';

/**
 * The display list: a small, pure description of what a node or edge looks like.
 *
 * It exists so that the canvas and the exporter cannot drift apart. Both consume
 * this same structure — the canvas turns it into React elements, the exporter
 * into an SVG string — so a change to a node's appearance lands in both places
 * or in neither.
 *
 * Interactive chrome (handles, resize controls, selection rings, inline editors)
 * is deliberately *not* representable here. That is what keeps editor furniture
 * out of exported images without anyone having to remember to strip it.
 */

/** A resolved colour. Never a CSS variable — the exporter needs literal values. */
export type Paint = string;

export interface Stroke {
  color: Paint;
  width: number;
  /** Dash pattern in user units. */
  dash?: number[];
  linecap?: 'butt' | 'round';
}

export type TextAlign = 'start' | 'middle' | 'end';

export interface RectShape {
  t: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  fill?: Paint;
  stroke?: Stroke;
  /** Applies the one shared shadow filter. There is deliberately only one. */
  shadow?: boolean;
  opacity?: number;
}

export interface EllipseShape {
  t: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  fill?: Paint;
  stroke?: Stroke;
  shadow?: boolean;
  opacity?: number;
}

export interface PathShape {
  t: 'path';
  d: string;
  fill?: Paint;
  stroke?: Stroke;
  /** Applies the one shared shadow filter. There is deliberately only one. */
  shadow?: boolean;
  opacity?: number;
  markerEnd?: string;
  markerStart?: string;
}

export interface TextShape {
  t: 'text';
  /** Anchor x. Its meaning depends on `align`. */
  x: number;
  /** Top of the text block, not the baseline — baselines are derived. */
  y: number;
  layout: TextLayout;
  font: FontSpec;
  fill: Paint;
  align: TextAlign;
  opacity?: number;
  /** Marks the node's own primary, user-typed label (as opposed to a kind badge, preset tag, or
   *  other decorative caption). Purely a lookup aid for chrome outside the display list — the
   *  inline editor reads it back off `describeNode`'s output to size itself at the same font the
   *  fitted label actually rendered at, rather than guessing. Never affects emitted SVG/PNG output. */
  role?: 'label';
  /** The primary label's available width, for its inline editor. Lookup metadata only, never emitted. */
  labelWidth?: number;
}

/** One run of a rich text line: its own font and colour, pinned to where layout placed it. */
export interface TextRun {
  /** The run's left edge. */
  x: number;
  text: string;
  width: number;
  font: FontSpec;
  fill: Paint;
}

/**
 * Lines of differently styled runs — a Text element's Markdown, as `layoutRichText` laid it out.
 * Backgrounds, rules, underlines and list markers are ordinary shapes around it; this carries only
 * the words, so emphasis and selection chrome treat it like any other text.
 */
export interface RichTextShape {
  t: 'rich';
  lines: { baseline: number; rtl?: boolean; runs: TextRun[] }[];
  opacity?: number;
}

export interface CodeShape {
  t: 'code';
  x: number;
  y: number;
  lines: CodeLine[];
  font: FontSpec;
  lineHeight: number;
  charWidth: number;
  ascent: number;
  descent: number;
  theme: CodeTheme;
  /** Lines outside this window are not emitted at all. */
  firstLine: number;
  lastLine: number;
}

export interface GroupShape {
  t: 'group';
  children: Shape[];
  /** Native SVG description, for a visual whose identifying text is intentionally not drawn. */
  title?: string;
  clip?: { x: number; y: number; w: number; h: number; r?: number };
  opacity?: number;
  /** Applied after `scale`: a point `p` in the group lands at `scale * p + translate`. */
  translate?: { x: number; y: number };
  /** Uniform. Strokes scale with it — a caller that wants them to keep their width divides them. */
  scale?: number;
}

export type Shape =
  | RectShape
  | EllipseShape
  | PathShape
  | TextShape
  | RichTextShape
  | CodeShape
  | GroupShape;

export interface DisplayList {
  width: number;
  height: number;
  shapes: Shape[];
}
