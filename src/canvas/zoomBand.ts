/**
 * Semantic zoom: how much of a connector's small print the canvas shows at a given zoom. Below
 * `FAR` the words beside a line (captions, conditions, reply labels, attachment chips) are too small
 * to read and only fog the structure; below `OVERVIEW` so are its labels. The shapes and the lines
 * themselves always show. Presentation only: nothing is hidden from the file or from an export.
 */
export type ZoomBand = 'far' | 'overview';

export const ZOOM_FAR = 0.55;
export const ZOOM_OVERVIEW = 0.28;

export function zoomBand(zoom: number): ZoomBand | null {
  if (zoom < ZOOM_OVERVIEW) return 'overview';
  return zoom < ZOOM_FAR ? 'far' : null;
}
