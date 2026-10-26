import { CONNECTOR_STYLE, connectorHead } from '../connectorStyle';
import { scopedId } from './ids';
import { jitter } from '../roughness/seed';
import { el, type SvgEl } from './element';

/** Shared definitions keep the canvas and exported arrowheads identical. Literal colours avoid
 * context-stroke, which is unevenly supported during PNG rasterization. */
export type MarkerVariant = 'closed' | 'open';

function markerId(color: string, variant: MarkerVariant): string {
  return scopedId(`dc-arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}${variant === 'open' ? '-open' : ''}`);
}

export function markerRef(color: string, variant: MarkerVariant = 'closed'): string {
  return `url(#${markerId(color, variant)})`;
}

/** Jitter the back of a head while fixing its tip. Used for shared Draft markers and per-edge
 * pencil heads; the same seeded point is repeated identically when a curve revisits it. */
export function headPath(variant: MarkerVariant, seed: string, amplitude = 0): string {
  return connectorHead(variant === 'open').replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_, sx, sy) => {
    const x = Number(sx), y = Number(sy);
    if (x === 14 && y === 5) return '14 5';
    return `${x + jitter(seed, x * 20 + y * 2, amplitude)} ${y + jitter(seed, x * 20 + y * 2 + 1, amplitude)}`;
  });
}

function arrowMarker(color: string, variant: MarkerVariant, amplitude: number): SvgEl {
  const open = variant === 'open';
  const { arrowLength, arrowWidth, openArrowWidth } = CONNECTOR_STYLE;
  const padding = amplitude + openArrowWidth / 2;
  return el('marker', {
    id: markerId(color, variant),
    viewBox: `${-padding} ${-padding} ${arrowLength + padding * 2} ${arrowWidth + padding * 2}`,
    refX: arrowLength - 0.5,
    refY: arrowWidth / 2,
    markerWidth: arrowLength + padding * 2,
    markerHeight: arrowWidth + padding * 2,
    markerUnits: 'userSpaceOnUse',
    orient: 'auto-start-reverse',
  }, [el('path', {
    d: headPath(variant, `marker:${color}:${variant}`, amplitude),
    fill: open ? 'none' : color,
    stroke: open ? color : undefined,
    'stroke-width': open ? openArrowWidth : undefined,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  })]);
}

export function markerDefs(colors: Iterable<string>, arrowJitter = 0): SvgEl[] {
  return [...new Set(colors)].flatMap(color =>
    (['closed', 'open'] as const).map(variant => arrowMarker(color, variant, arrowJitter)),
  );
}
