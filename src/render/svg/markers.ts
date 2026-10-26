import { CONNECTOR_APPEARANCES, type ConnectorAppearance } from '../../document/types';
import { CONNECTOR_STYLE, connectorHead } from '../connectorStyle';
import { scopedId } from './ids';
import { jitter } from '../roughness/seed';
import { el, type SvgEl } from './element';

/** Shared definitions keep the canvas and exported arrowheads identical. Literal colours avoid
 * context-stroke, which is unevenly supported during PNG rasterization. */
export type MarkerVariant = 'closed' | 'open';

function markerId(color: string, variant: MarkerVariant, appearance: ConnectorAppearance): string {
  const style = appearance === 'sculpted' ? '' : `-${appearance}`;
  return scopedId(`dc-arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}${style}${variant === 'open' ? '-open' : ''}`);
}

export function markerRef(color: string, variant: MarkerVariant = 'closed', appearance: ConnectorAppearance = 'sculpted'): string {
  return `url(#${markerId(color, variant, appearance)})`;
}

/** Jitter the back of a head while fixing its tip. Used for shared Draft markers and per-edge
 * pencil heads; the same seeded point is repeated identically when a curve revisits it. */
export function headPath(appearance: ConnectorAppearance, variant: MarkerVariant, seed: string, amplitude = 0): string {
  return connectorHead(appearance, variant === 'open').replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_, sx, sy) => {
    const x = Number(sx), y = Number(sy);
    if (x === 14 && y === 5) return '14 5';
    return `${x + jitter(seed, x * 20 + y * 2, amplitude)} ${y + jitter(seed, x * 20 + y * 2 + 1, amplitude)}`;
  });
}

function arrowMarker(color: string, variant: MarkerVariant, amplitude: number, appearance: ConnectorAppearance): SvgEl {
  const open = variant === 'open';
  const { arrowLength, arrowWidth, openArrowWidth } = CONNECTOR_STYLE;
  const padding = amplitude + openArrowWidth / 2;
  return el('marker', {
    id: markerId(color, variant, appearance),
    viewBox: `${-padding} ${-padding} ${arrowLength + padding * 2} ${arrowWidth + padding * 2}`,
    refX: arrowLength - 0.5,
    refY: arrowWidth / 2,
    markerWidth: arrowLength + padding * 2,
    markerHeight: arrowWidth + padding * 2,
    markerUnits: 'userSpaceOnUse',
    orient: 'auto-start-reverse',
  }, [el('path', {
    d: headPath(appearance, variant, `marker:${color}:${variant}`, amplitude),
    fill: open || appearance === 'pencil' ? 'none' : color,
    stroke: open || appearance === 'pencil' ? color : undefined,
    'stroke-width': appearance === 'pencil' ? 1.2 : open ? openArrowWidth : undefined,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  })]);
}

export function markerDefs(colors: Iterable<string>, arrowJitter = 0, appearances: readonly ConnectorAppearance[] = ['sculpted']): SvgEl[] {
  return [...new Set(colors)].flatMap((color) => appearances.flatMap((appearance) =>
    (['closed', 'open'] as const).map((variant) => arrowMarker(color, variant, appearance === 'sculpted' ? arrowJitter : 0, appearance)),
  ));
}

function ribbonId(color: string): string {
  return scopedId(`dc-ribbon-${color.replace(/[^a-zA-Z0-9]/g, '')}`);
}

export function ribbonPaintRef(color: string): string {
  return `url(#${ribbonId(color)})`;
}

/** User-space gradients also paint perfectly horizontal/vertical strokes (zero-area bounds). */
export function connectorDefs(colors: Iterable<string>, arrowJitter = 0): SvgEl[] {
  const unique = [...new Set(colors)];
  return [
    ...markerDefs(unique, arrowJitter, CONNECTOR_APPEARANCES),
    ...unique.map((color) => el('linearGradient', {
      id: ribbonId(color), gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 480, y2: 240, spreadMethod: 'reflect',
    }, [el('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.72 }), el('stop', { offset: 1, 'stop-color': color })])),
  ];
}
