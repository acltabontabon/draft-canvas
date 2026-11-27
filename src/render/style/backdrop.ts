import type { Shape } from '../displayList';
import { el, serialize } from '../svg/element';
import { emitShape } from '../svg/emit';
import type { ThemeName } from '../theme/tokens';
import { artShapes } from './art';
import type { ResolvedStyle } from './resolve';

/**
 * A style's backdrop, as one tile ready to repeat: what the canvas, every export and every preview
 * put behind the diagram.
 *
 * The tile is the style's own drawing, so it is the same inert paths and colours as any other
 * (`StyleAsset`). Painted by role it follows the theme: a part in the text colour is dark on a
 * light canvas and light on a dark one.
 */
export interface BackdropTile {
  /** One tile, in canvas pixels at 100%. */
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  /** The tile's paths, placed in `0 0 width height`. */
  readonly shapes: readonly Shape[];
  /** The tile as a picture a stylesheet can repeat (`background-image`). */
  readonly uri: string;
}

const TILES = new WeakMap<ResolvedStyle, Partial<Record<ThemeName, BackdropTile>>>();

/** The backdrop `style` draws in `device`'s theme, or `null` when it has none. The same object every time. */
export function backdropTile(style: ResolvedStyle, device: ThemeName): BackdropTile | null {
  const backdrop = style.backdrop;
  if (!backdrop) return null;
  let known = TILES.get(style);
  if (!known) TILES.set(style, (known = {}));
  const made = known[device];
  if (made) return made;

  const theme = style.theme(device);
  const width = Math.max(8, Math.round(backdrop.art.w * backdrop.scale));
  const height = Math.max(8, Math.round(backdrop.art.h * backdrop.scale));
  const drawn = artShapes(backdrop.art, { x: 0, y: 0, w: width, h: height }, 'stretch', theme.accents.neutral, theme);
  // Fainter is the whole tile laid lighter; stronger is each part of it laid heavier, up to solid.
  // A group can be no more than opaque: Strong was once clamped there and drew exactly Regular.
  const opacity = Math.min(1, backdrop.opacity);
  const boost = backdrop.opacity / opacity;
  const shapes =
    boost === 1
      ? drawn
      : drawn.map((shape) => (shape.t === 'path' && shape.opacity !== undefined ? { ...shape, opacity: Math.min(1, Math.round(shape.opacity * boost * 1000) / 1000) } : shape));
  const markup = serialize(
    el('svg', { xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: `0 0 ${width} ${height}` }, [
      el('g', { opacity, 'stroke-linejoin': 'round' }, shapes.flatMap(emitShape)),
    ]),
  );
  const tile: BackdropTile = { width, height, opacity, shapes, uri: `url("data:image/svg+xml,${encodeURIComponent(markup)}")` };
  known[device] = tile;
  return tile;
}
