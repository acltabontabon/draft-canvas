import type { EllipseShape, PathShape, RectShape, Shape } from '../render/displayList';

/**
 * Presentation emphasis: the shape the step is about, gently lit along its own contour.
 *
 * What lights up is the shape's *silhouette* — the closed, filled bodies it is drawn from (a
 * card, a cylinder, a tube, a bust and its card) — traced again in their own line colour, a
 * little heavier, with no fill and no words. `DraftNodeView` paints that tracing *behind* the
 * shape's surface and gives the whole layer one soft halo (`.dc-emphasis` in `canvas.css`), so
 * the shape's own opaque fill hides everything inside its outline: an inner glyph, a lid, a seam
 * or a row of dots is never re-stroked and never glows, and the halo shows only past the contour
 * — a cylinder gets a cylinder's halo, not a rectangle's. Interactive chrome, never exported.
 */

/** How much heavier than its own stroke a lit shape's outline is drawn, in the shape's units. */
export const EMPHASIS_STROKE_GAIN = 1.5;

/**
 * The silhouette of `shapes`, as a display list to draw behind them.
 *
 * A body is a stroked shape with a fill: the surface of a shape, whose outline is the contour the
 * eye follows. A shape with no body at all — a Boundary is a faint fill and a separate outline —
 * falls back to its stroked outlines, skipping the half-strength retrace passes Sketch adds so a
 * hand-drawn shape lights along one line rather than two. Groups keep their clip, translate and
 * scale, and the gain is divided by the scale a group applies (as `scaledGlyph` in
 * `nodes/describe.ts` does for the stroke itself) so a scaled-up Data Store is not lit heavier.
 */
export function emphasisOf(shapes: readonly Shape[]): Shape[] {
  const bodies = pick(shapes, (shape) => shape.fill !== undefined && shape.fill !== 'none', 1);
  if (bodies.length > 0) return bodies;
  return pick(shapes, (shape) => (shape.opacity ?? 1) >= 0.8, 1);
}

/** The colour the silhouette is drawn in — the first lit outline's own line colour. */
export function emphasisColorOf(shapes: readonly Shape[]): string | null {
  for (const shape of shapes) {
    if (shape.t === 'group') {
      const inner = emphasisColorOf(shape.children);
      if (inner) return inner;
      continue;
    }
    if (shape.t === 'text' || shape.t === 'code' || !shape.stroke) continue;
    return shape.stroke.color;
  }
  return null;
}

type Outlined = RectShape | EllipseShape | PathShape;

function pick(shapes: readonly Shape[], keep: (shape: Outlined) => boolean, scale: number): Shape[] {
  const kept: Shape[] = [];
  for (const shape of shapes) {
    if (shape.t === 'text' || shape.t === 'code') continue;
    if (shape.t === 'group') {
      const children = pick(shape.children, keep, scale * (shape.scale ?? 1));
      if (children.length > 0) kept.push({ ...shape, children });
      continue;
    }
    if (!shape.stroke || !keep(shape)) continue;
    kept.push({
      ...shape,
      fill: 'none',
      shadow: false,
      stroke: { ...shape.stroke, width: shape.stroke.width + EMPHASIS_STROKE_GAIN / scale },
    });
  }
  return kept;
}
