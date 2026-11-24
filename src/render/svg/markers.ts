import { CONNECTOR_STYLE, connectorHead } from '../connectorStyle';
import type { StyleHead } from '../../document/style';
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
export function headPath(variant: MarkerVariant, seed: string, amplitude = 0, head: StyleHead = 'nib'): string {
  return connectorHead(variant === 'open', head).replace(/(-?\d*\.?\d+) (-?\d*\.?\d+)/g, (_, sx, sy) => {
    const x = Number(sx), y = Number(sy);
    if (x === CONNECTOR_STYLE.arrowLength && y === CONNECTOR_STYLE.arrowWidth / 2) return `${x} ${y}`;
    return `${x + jitter(seed, x * 20 + y * 2, amplitude)} ${y + jitter(seed, x * 20 + y * 2 + 1, amplitude)}`;
  });
}

function arrowMarker(color: string, variant: MarkerVariant, amplitude: number, head: StyleHead): SvgEl {
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
    d: headPath(variant, `marker:${color}:${variant}`, amplitude, head),
    fill: open ? 'none' : color,
    stroke: open ? color : undefined,
    'stroke-width': open ? openArrowWidth : undefined,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  })]);
}

function originId(color: string): string {
  return scopedId(`dc-origin-${color.replace(/[^a-zA-Z0-9]/g, '')}`);
}

/** The dot a directed connector starts from (`CONNECTOR_STYLE.originRadius`), as a `marker-start`. */
export function originRef(color: string): string {
  return `url(#${originId(color)})`;
}

/**
 * A start marker is turned to face back down the line (`auto-start-reverse`), so its own +x points
 * into the shape: the dot is drawn at −x, which puts it on the line just clear of the shape's edge
 * rather than half under it.
 */
function originMarker(color: string): SvgEl {
  const { originRadius: r, originGap: gap } = CONNECTOR_STYLE;
  const reach = gap + r + 0.5;
  return el('marker', {
    id: originId(color),
    viewBox: `${-reach} ${-r - 0.5} ${reach + 0.5} ${r * 2 + 1}`,
    refX: 0,
    refY: 0,
    markerWidth: reach + 0.5,
    markerHeight: r * 2 + 1,
    markerUnits: 'userSpaceOnUse',
    orient: 'auto-start-reverse',
  }, [el('circle', { cx: -gap, cy: 0, r, fill: color })]);
}

/** One head shape per picture, so a marker's id needs only its colour: see `connectorHead`. */
export function markerDefs(colors: Iterable<string>, arrowJitter = 0, head: StyleHead = 'nib'): SvgEl[] {
  return [...new Set(colors)].flatMap(color => [
    ...(['closed', 'open'] as const).map(variant => arrowMarker(color, variant, arrowJitter, head)),
    originMarker(color),
  ]);
}
