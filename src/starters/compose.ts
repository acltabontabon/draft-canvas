/**
 * The composition vocabulary the starter catalog is authored against.
 *
 * Deliberately tiny. These are shared spacing constants and three placement helpers — not a layout
 * engine, and not a substitute for authoring. Draft Canvas has no auto-layout library, and for five
 * diagrams whose structure is known in advance it doesn't want one: a generic solver produces
 * something defensible, and what a starter needs is something *composed*. Everything the helpers
 * below can't express is a literal coordinate in `catalog.ts`, on purpose.
 */

/** Horizontal gap between sibling elements in a row. */
export const GUTTER = 72;

/**
 * Vertical gap between two layers of a diagram. Sized to hold a connector's relationship caption
 * (`edgeSemantics.ts`'s `relationshipCaptionLabel`) with clear air above and below it, and to leave
 * a fan-out enough corridor to plan a shared trunk (`edges/bundles.ts` needs `MIN_STEM` +
 * `MIN_BRANCH` = 56 at an absolute minimum).
 */
export const BAND = 104;

/** A layer gap inside a boundary, where the containing box already provides visual separation. */
export const INNER_BAND = 72;

/** Left, right and bottom breathing room inside a boundary. */
export const BOUNDARY_PAD = 36;

/**
 * Top breathing room inside a boundary: its preset caption and title are drawn at y 8–34 by
 * `nodes/describe.ts`'s `group()`, so anything less than this collides with the label.
 */
export const BOUNDARY_HEADER = 56;

/** The same, for a boundary with no title of its own — only the small uppercase preset caption. */
export const BOUNDARY_HEADER_CAPTION_ONLY = 40;

/**
 * The same, for a boundary with a title but no preset caption above it — `boundaryPreset:
 * 'boundary'` is the one preset `nodes/describe.ts`'s `BOUNDARY_PRESET_LABELS` has no entry for,
 * so nothing is drawn ahead of the title and it starts higher (y 9, not y 8+caption+2). Kept as
 * its own named constant rather than reused ad hoc: a boundary that wants a real title with no
 * extra tag above it is a real, nameable shape a future starter can reach for.
 */
export const BOUNDARY_HEADER_TITLE_ONLY = 44;

/** The left edge that centres something of `width` on `cx`. */
export function centeredAt(cx: number, width: number): number {
  return Math.round(cx - width / 2);
}

/**
 * Left edges for `count` equal columns of `width`, centred as a group on `cx`. The one repeated
 * arrangement in the catalog — three services, three modules, two consumers.
 */
export function columnsAt(cx: number, count: number, width: number, gutter = GUTTER): number[] {
  const span = count * width + (count - 1) * gutter;
  const left = cx - span / 2;
  return Array.from({ length: count }, (_, index) => Math.round(left + index * (width + gutter)));
}
