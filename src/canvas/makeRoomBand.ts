/**
 * Where the Make room band is drawn while a drag pushes room open or closes it (`useMakeRoom.ts`),
 * in flow units: the stretch made or closed along the drag's axis, and across it, far past anything
 * in view.
 */

/** How far the band runs either way across its axis: beyond any view, without a size no browser draws. */
export const ROOM_LINE_REACH = 200_000;

/** How far the view's middle moves before the band is centred again: far inside the reach, so a pan
 *  redraws it only once it has gone a long way. */
const CENTRE_STEP = 50_000;

export interface MakeRoomLine {
  axis: 'x' | 'y';
  at: number;
  delta: number;
}

/**
 * The band's box. Across its axis it is centred on `across`, where the view is: the press point is in
 * view, wherever on the canvas that is. It was centred on the origin, so on a diagram further out than
 * the reach (coordinates go to ±1,000,000) no band was drawn at all.
 */
export function makeRoomBand(line: MakeRoomLine, across: number): { left: number; top: number; width: number; height: number } {
  const from = Math.min(line.at, line.at + line.delta);
  const span = Math.abs(line.delta);
  return line.axis === 'x'
    ? { left: from, top: across - ROOM_LINE_REACH, width: span, height: ROOM_LINE_REACH * 2 }
    : { left: across - ROOM_LINE_REACH, top: from, width: ROOM_LINE_REACH * 2, height: span };
}

/**
 * The middle of the view across `axis`, in flow units, in steps of `CENTRE_STEP` — a number that
 * stays the same while the view holds nearly still. `transform` is the viewport's `[x, y, zoom]`.
 */
export function viewAcross(axis: MakeRoomLine['axis'], transform: readonly [number, number, number], width: number, height: number): number {
  const [x, y, zoom] = transform;
  const scale = zoom > 0 ? zoom : 1;
  const middle = axis === 'x' ? (height / 2 - y) / scale : (width / 2 - x) / scale;
  return Number.isFinite(middle) ? Math.round(middle / CENTRE_STEP) * CENTRE_STEP : 0;
}
