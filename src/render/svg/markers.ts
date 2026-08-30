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

export function markerId(color: string): string {
  return `dc-arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export function markerRef(color: string): string {
  return `url(#${markerId(color)})`;
}

function arrowMarker(color: string): SvgEl {
  return el(
    'marker',
    {
      id: markerId(color),
      viewBox: `0 0 ${ARROW_LENGTH} ${ARROW_WIDTH}`,
      refX: ARROW_LENGTH - 0.5,
      refY: ARROW_WIDTH / 2,
      markerWidth: ARROW_LENGTH,
      markerHeight: ARROW_WIDTH,
      // Keeps the arrow a constant size regardless of the line's stroke width.
      markerUnits: 'userSpaceOnUse',
      orient: 'auto-start-reverse',
    },
    [
      el('path', {
        d: `M0,0 L${ARROW_LENGTH},${ARROW_WIDTH / 2} L0,${ARROW_WIDTH} Z`,
        fill: color,
      }),
    ],
  );
}

/** Marker definitions for every colour the document actually uses. */
export function markerDefs(colors: Iterable<string>): SvgEl[] {
  const unique = [...new Set(colors)];
  return unique.map(arrowMarker);
}
