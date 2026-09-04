import { jitter } from '../roughness/seed';
import { el, type SvgEl } from './element';

/**
 * Arrowheads.
 *
 * React Flow's built-in `MarkerType.ArrowClosed` is not used: its geometry lives
 * inside the library, so the exporter would have to reverse-engineer it and would
 * silently diverge on any upgrade. Defining the arrow once here means the canvas
 * and the exported file reference identical marker definitions.
 *
 * `context-stroke` would avoid per-colour markers but is unevenly supported and
 * fails during PNG rasterization in some browsers, so a marker is minted per
 * colour instead. There are at most eight colours in the whole design system.
 *
 * Only Clean and Draft ever *reference* a minted marker — Sketch draws its
 * arrowheads inline, per-edge (`render/roughness/roughArrow.ts`), since a shared
 * `<marker>` def has no way to vary per edge the way Sketch's other primitives do.
 * A marker is still minted for every preset regardless (defensive completeness,
 * near-zero cost), seeded by a *fixed*, non-per-edge string — every edge of a
 * colour shares the one subtly-imperfect triangle at Draft, unlike Sketch's
 * per-instance one.
 */
const ARROW_LENGTH = 9;
const ARROW_WIDTH = 7;

/**
 * `closed` is the ordinary filled triangle every directed connector uses.
 * `open` is an unfilled outline — used for a `callback` connector's return
 * arrow, so a forward/return pair reads as distinct at a glance even before
 * lane separation or direction is noticed. Drawn as a stroke with no fill
 * rather than "punched through" to a background colour, so it looks correct
 * against any theme or export background without needing to know either.
 */
export type MarkerVariant = 'closed' | 'open';

export function markerId(color: string, variant: MarkerVariant = 'closed'): string {
  const suffix = variant === 'open' ? '-open' : '';
  return `dc-arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}${suffix}`;
}

export function markerRef(color: string, variant: MarkerVariant = 'closed'): string {
  return `url(#${markerId(color, variant)})`;
}

/**
 * `amplitude === 0` (Clean) reproduces the original crisp triangle exactly, byte-for-byte — the
 * two back corners only move once `amplitude` is above zero, each independently, off a seed keyed
 * by colour+variant (not an edge id), so the wobble stays fixed across the whole document rather
 * than looking hand-picked per connector.
 */
function arrowMarker(color: string, variant: MarkerVariant, amplitude: number): SvgEl {
  const j = (i: number) => jitter(`marker:${color}:${variant}`, i, amplitude);
  const tip = { x: ARROW_LENGTH, y: ARROW_WIDTH / 2 };
  const back1 = { x: j(0), y: j(1) };
  const back2 = { x: j(2), y: ARROW_WIDTH + j(3) };
  const shape =
    variant === 'open'
      ? el('path', {
          d: `M${back1.x + 0.7},${back1.y + 0.7} L${tip.x - 0.7},${tip.y} L${back2.x + 0.7},${back2.y - 0.7}`,
          fill: 'none',
          stroke: color,
          'stroke-width': 1.3,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        })
      : el('path', { d: `M${back1.x},${back1.y} L${tip.x},${tip.y} L${back2.x},${back2.y} Z`, fill: color });

  return el(
    'marker',
    {
      id: markerId(color, variant),
      viewBox: `0 0 ${ARROW_LENGTH} ${ARROW_WIDTH}`,
      refX: ARROW_LENGTH - 0.5,
      refY: ARROW_WIDTH / 2,
      markerWidth: ARROW_LENGTH,
      markerHeight: ARROW_WIDTH,
      // Keeps the arrow a constant size regardless of the line's stroke width.
      markerUnits: 'userSpaceOnUse',
      orient: 'auto-start-reverse',
    },
    [shape],
  );
}

/** Marker definitions — both variants, for every colour the document actually uses, at the active
 *  preset's `arrowJitter` amplitude (0 for Clean, the original untouched default). */
export function markerDefs(colors: Iterable<string>, arrowJitter = 0): SvgEl[] {
  const unique = [...new Set(colors)];
  return unique.flatMap((color) => [arrowMarker(color, 'closed', arrowJitter), arrowMarker(color, 'open', arrowJitter)]);
}
