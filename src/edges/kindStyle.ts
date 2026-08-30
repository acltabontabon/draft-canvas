import type { DraftEdge } from '../document/types';
import type { MarkerVariant } from '../render/svg/markers';

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
