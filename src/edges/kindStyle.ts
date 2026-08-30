import type { Accent, DraftEdge } from '../document/types';
import type { MarkerVariant } from '../render/svg/markers';
import { accentOf, type Theme } from '../render/theme/tokens';

/**
 * A connector's dash pattern, as an array of on/off lengths (SVG
 * `stroke-dasharray` units) — shared by both renderers so the flow-kind
 * vocabulary stays visually consistent between the canvas and an exported
 * file, even though how each renderer turns this array into a stroke (a
 * display-list `Shape`'s `stroke.dash` field vs a DOM element's CSS
 * `strokeDasharray` string) stays renderer-specific by design. See
 * `docs/ARCHITECTURE.md`'s note on the two independent edge renderers.
 */
export function dashForEdge(edge: DraftEdge): number[] | undefined {
  switch (edge.kind) {
    case 'event':
      return [1, 4];
    case 'retry':
      return [7, 3, 1, 3];
    case 'fallback':
      return [2, 5];
    default:
      // sync / async / callback / conditional / failure / no kind: any
      // dashing comes from the existing `async` flag — `kind` doesn't
      // override or duplicate it, it only adds a distinct pattern for the
      // kinds `async` can't already express.
      return edge.async ? [6, 4] : undefined;
  }
}

/** A callback's return arrow reads as hollow, so a forward/return pair is
 *  distinct even before lane separation or direction is noticed. */
export function markerVariantForEdge(edge: DraftEdge): MarkerVariant {
  return edge.kind === 'callback' ? 'open' : 'closed';
}

/**
 * A connector's colour — shared by both renderers so tracing a flow from its
 * source node looks the same on screen and in an exported file.
 *
 * An explicit `edge.accent` is a deliberate override and keeps using `chip`,
 * the same vivid tone a manually-recoloured node uses. Absent that, the
 * connector borrows its source node's own accent at the softer `line`
 * intensity — connector-appropriate, not attention-grabbing — so tracing a
 * flow from a coloured node needs no configuration at all. A source with no
 * accent (or `neutral`, on either the edge or the node) falls back to the
 * theme's plain connector grey, exactly as an unaccented edge always has.
 */
export function resolveEdgeColor(
  edge: Pick<DraftEdge, 'accent'>,
  sourceNode: { accent?: Accent } | undefined,
  theme: Theme,
): string {
  const explicit = edge.accent;
  const effective = explicit ?? sourceNode?.accent ?? 'neutral';
  if (effective === 'neutral') return theme.edge;
  const palette = accentOf(theme, effective);
  return explicit !== undefined ? palette.chip : palette.line;
}
