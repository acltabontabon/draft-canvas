/**
 * The composition vocabulary the starter catalog is authored against.
 *
 * Deliberately tiny. These are shared spacing constants and three placement helpers — not a layout
 * engine, and not a substitute for authoring. Draft Canvas has no auto-layout library, and for nine
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

/**
 * The boundary title's own left inset (`nodes/describe.ts`'s `group()` draws it at local `x: 12`,
 * the module's own `PADDING` constant). A child node is ordinarily held to `BOUNDARY_PAD`'s wider
 * inset (see `tests/starters.test.ts`'s "clear of the boundary caption" check) — this narrower one
 * is only for a header annotation meant to read as a continuation of the title itself, sharing its
 * exact left edge rather than falling back to a generic child's own breathing room.
 */
export const BOUNDARY_TITLE_INSET = 12;

/**
 * Where a second header line belongs when stacked directly beneath a title-only boundary's own
 * title (`boundaryPreset: 'boundary'`, no preset caption) — the title's own top inset (9) plus one
 * `groupTitle` line (12 × 1.35 ≈ 16), plus a few px of daylight. This is deliberately tighter than
 * `BOUNDARY_HEADER_TITLE_ONLY` (44, the room reserved before a boundary's *other* content begins):
 * that constant answers "how far down can real content start," this one answers "how close can a
 * subtitle sit to the title it belongs to."
 */
export const BOUNDARY_TITLE_SUBLINE_Y = 30;

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
