/**
 * Font stacks are system-only, deliberately.
 *
 * Nothing is fetched, so the app works offline and — more importantly — an SVG
 * rasterized through an `Image` into a canvas can still resolve its fonts. A
 * webfont would silently fail to load inside that sandbox and every PNG export
 * would come out in Times New Roman.
 *
 * The concrete family names at the tail of each stack matter as much as the
 * `system-ui` keyword: Inkscape, Illustrator and Figma resolve none of the
 * `ui-*` keywords when opening an exported .svg.
 */
export const FONT_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const FONT_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export type FontStack = 'sans' | 'mono';
export type FontWeight = 400 | 500 | 600 | 700;

export interface FontSpec {
  stack: FontStack;
  size: number;
  weight: FontWeight;
  italic?: boolean;
}

export function familyOf(stack: FontStack): string {
  return stack === 'mono' ? FONT_MONO : FONT_SANS;
}

/** A canonical key for caching, and the value a canvas 2D context wants. */
export function cssFont(font: FontSpec): string {
  const style = font.italic ? 'italic ' : '';
  return `${style}${font.weight} ${font.size}px ${familyOf(font.stack)}`;
}

export const TEXT_SIZES = {
  nodeLabel: 14,
  nodeLabelLarge: 15,
  nodeSubtitle: 11,
  presetTag: 10,
  noteBody: 13,
  freeText: 15,
  code: 12.5,
  edgeLabel: 11.5,
  sequenceBadge: 11,
  groupTitle: 12,
  connectorCaption: 9.5,
} as const;

/** Line heights are absolute multiples so the exporter can reproduce them exactly. */
export const LINE_HEIGHTS = {
  label: 1.35,
  body: 1.45,
  code: 1.55,
} as const;

export const FONTS = {
  nodeLabel: { stack: 'sans', size: TEXT_SIZES.nodeLabel, weight: 600 } satisfies FontSpec,
  nodeSubtitle: { stack: 'sans', size: TEXT_SIZES.nodeSubtitle, weight: 500 } satisfies FontSpec,
  presetTag: { stack: 'sans', size: TEXT_SIZES.presetTag, weight: 600 } satisfies FontSpec,
  noteBody: { stack: 'sans', size: TEXT_SIZES.noteBody, weight: 400 } satisfies FontSpec,
  freeText: { stack: 'sans', size: TEXT_SIZES.freeText, weight: 500 } satisfies FontSpec,
  code: { stack: 'mono', size: TEXT_SIZES.code, weight: 400 } satisfies FontSpec,
  edgeLabel: { stack: 'sans', size: TEXT_SIZES.edgeLabel, weight: 500 } satisfies FontSpec,
  sequenceBadge: { stack: 'sans', size: TEXT_SIZES.sequenceBadge, weight: 700 } satisfies FontSpec,
  groupTitle: { stack: 'sans', size: TEXT_SIZES.groupTitle, weight: 600 } satisfies FontSpec,
  connectorCaption: { stack: 'sans', size: TEXT_SIZES.connectorCaption, weight: 500 } satisfies FontSpec,
} as const;
