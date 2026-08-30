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

function arrowMarker(color: string, variant: MarkerVariant): SvgEl {
  const trianglePath = `M0.7,0.7 L${ARROW_LENGTH - 0.7},${ARROW_WIDTH / 2} L0.7,${ARROW_WIDTH - 0.7}`;
  const shape =
    variant === 'open'
      ? el('path', {
          d: trianglePath,
          fill: 'none',
          stroke: color,
          'stroke-width': 1.3,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        })
      : el('path', { d: `M0,0 L${ARROW_LENGTH},${ARROW_WIDTH / 2} L0,${ARROW_WIDTH} Z`, fill: color });

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

/** Marker definitions — both variants, for every colour the document actually uses. */
export function markerDefs(colors: Iterable<string>): SvgEl[] {
  const unique = [...new Set(colors)];
  return unique.flatMap((color) => [arrowMarker(color, 'closed'), arrowMarker(color, 'open')]);
}
