import type { LibraryShape, ShapeKind } from '../../document/types';

/** Nothing smaller than this is a mark; it is a smudge. */
const MIN_MARK = 3;

export interface ShapeBox {
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/**
 * Fits a `LibraryShape` (longer axis 1000) into a `width` × `height` box, centred, with every
 * mark at least `MIN_MARK` on each side. Shared by the library row and the home screen's starter
 * glyphs, so the two can never disagree about where a node sits.
 */
export function layoutShape(shape: LibraryShape, width: number, height: number, pad: number): ShapeBox[] {
  const scale = Math.min((width - 2 * pad) / Math.max(shape.w, 1), (height - 2 * pad) / Math.max(shape.h, 1));
  const ox = pad + (width - 2 * pad - shape.w * scale) / 2;
  const oy = pad + (height - 2 * pad - shape.h * scale) / 2;
  return shape.nodes.map(([kind, x, y, w, h]) => {
    const boxWidth = Math.max(MIN_MARK, w * scale);
    const boxHeight = Math.max(MIN_MARK, h * scale);
    // Grow around the centre when clamped, so a tiny node stays where it was.
    const left = ox + x * scale - (boxWidth - w * scale) / 2;
    const top = oy + y * scale - (boxHeight - h * scale) / 2;
    return { kind, x: left, y: top, w: boxWidth, h: boxHeight, cx: left + boxWidth / 2, cy: top + boxHeight / 2 };
  });
}
