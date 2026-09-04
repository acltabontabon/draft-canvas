import { jitter } from './seed';

/** Matches the shared marker geometry in `render/svg/markers.ts`, so a hand-drawn Sketch
 *  arrowhead reads as the same size as the crisp/shared-hand marker it replaces. */
const ARROW_LENGTH = 9;
const ARROW_WIDTH = 7;

/**
 * A hand-drawn arrowhead, drawn inline per-edge — Sketch only. (Clean and Draft use the shared,
 * cheaper `<marker>` defs in `render/svg/markers.ts` instead; see `PersonalityProfile.arrowStyle`.)
 *
 * `tip` is fixed exactly where the connector's routed endpoint is — never jittered, since an
 * arrow's target must stay precise. Only the two back corners move, and independently of each
 * other, so the wings read as genuinely asymmetric rather than merely wider or narrower. `dir`
 * must be a pre-normalized unit vector pointing in the direction of travel arriving at `tip`
 * (typically `edges/routing.ts`'s `endTangent`) — computed once by the caller rather than derived
 * here, since this can run once per drag frame.
 */
export function sketchArrowPath(
  tip: { x: number; y: number },
  dir: { x: number; y: number },
  seedId: string,
  amplitude: number,
  variant: 'closed' | 'open' = 'closed',
): string {
  const nx = -dir.y;
  const ny = dir.x;
  const backX = tip.x - dir.x * ARROW_LENGTH;
  const backY = tip.y - dir.y * ARROW_LENGTH;
  const j = (i: number) => jitter(seedId, i, amplitude);
  const wing1 = {
    x: backX + nx * (ARROW_WIDTH / 2) + dir.x * j(0) + nx * j(1),
    y: backY + ny * (ARROW_WIDTH / 2) + dir.y * j(0) + ny * j(1),
  };
  const wing2 = {
    x: backX - nx * (ARROW_WIDTH / 2) + dir.x * j(2) + nx * j(3),
    y: backY - ny * (ARROW_WIDTH / 2) + dir.y * j(2) + ny * j(3),
  };
  if (variant === 'open') {
    return `M${wing1.x},${wing1.y} L${tip.x},${tip.y} L${wing2.x},${wing2.y}`;
  }
  return `M${tip.x},${tip.y} L${wing1.x},${wing1.y} L${wing2.x},${wing2.y} Z`;
}
