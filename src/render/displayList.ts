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

export interface Corner {
  r: number;
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
  clip?: { x: number; y: number; w: number; h: number; r?: number };
  opacity?: number;
  translate?: { x: number; y: number };
}

export type Shape =
  | RectShape
  | EllipseShape
  | PathShape
  | TextShape
  | CodeShape
  | GroupShape;

export interface DisplayList {
  width: number;
  height: number;
  shapes: Shape[];
}

export const EMPTY_DISPLAY_LIST: DisplayList = { width: 0, height: 0, shapes: [] };
