import { getViewportForBounds } from '@xyflow/system';
import { boundsOf, type Bounds } from '../document/geometry';
import type { DraftViewport } from '../document/types';

/**
 * Where the camera goes when you step into a shape or back out of one, and where it sets off from.
 *
 * It lands where Fit to view (Shift 1) would: arriving in a room shows all of it, centred, however
 * the room was left. And it sets off from the shape the move is about, so the room grows out of
 * it going in, and shrinks back into it coming out (`DepthTransition` flies it).
 *
 * Worked out from the document rather than asked of React Flow, because `fitView` measures what is
 * rendered and the shapes it would measure on arrival are the ones being replaced. So the landing is
 * the same with the animation and without it, which reduced motion has to be able to promise.
 */

/** How long the move takes, flown or not. */
export const DEPTH_MOVE_MS = 640;

/** Fit to view's own options: the same padding, and the canvas's zoom limits. */
const FIT_PADDING = 0.2;
export const DEPTH_MIN_ZOOM = 0.1;
export const DEPTH_MAX_ZOOM = 4;

/** Under way at once, as a press of a key asks, and settling slowly into the room: half an ease out,
 *  half an ease in and out. A plain ease in and out sat still for the first frames, and read as lag. */
export const depthEase = (t: number) => 0.5 * (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2) + 0.5 * (1 - (1 - t) ** 3);

type Size = { width: number; height: number };
/** A rectangle on the canvas pane, in screen pixels from its top left. */
export type PaneRect = { x: number; y: number; width: number; height: number };

/** The camera Fit to view would choose for these shapes on a pane this size, or none for nothing. */
export function fitCamera(nodes: readonly Bounds[], pane: Size): DraftViewport | null {
  const bounds = boundsOf(nodes);
  if (!bounds || pane.width <= 0 || pane.height <= 0) return null;
  return getViewportForBounds(bounds, pane.width, pane.height, DEPTH_MIN_ZOOM, DEPTH_MAX_ZOOM, FIT_PADDING);
}

/**
 * The camera that puts `content` (flow coordinates) into `on` (pane pixels), centred and as large
 * as fits, or (`cover`) just large enough to cover it. Not held to the zoom limits: it is only ever a starting point, seen for the first frames
 * of the move, and clamping it would let the room jump off the shape it is meant to come out of.
 */
export function cameraInto(content: Bounds, on: PaneRect, cover = false): DraftViewport {
  const across = on.width / Math.max(content.width, 1);
  const down = on.height / Math.max(content.height, 1);
  const zoom = cover ? Math.max(across, down) : Math.min(across, down);
  return {
    x: on.x + on.width / 2 - (content.x + content.width / 2) * zoom,
    y: on.y + on.height / 2 - (content.y + content.height / 2) * zoom,
    zoom,
  };
}

/** A shape's inside starts a little inside its outline, so its edge reads as the room's doorway. */
const INSET = 0.14;

/**
 * Going in: the room's shapes, drawn small inside the outline of the shape they belong to, where
 * that shape was on screen when it was stepped into.
 */
export function cameraEntering(roomNodes: readonly Bounds[], entrance: PaneRect): DraftViewport | null {
  const bounds = boundsOf(roomNodes);
  if (!bounds) return null;
  const insetX = entrance.width * INSET;
  const insetY = entrance.height * INSET;
  return cameraInto(bounds, {
    x: entrance.x + insetX,
    y: entrance.y + insetY,
    width: entrance.width - insetX * 2,
    height: entrance.height - insetY * 2,
  });
}

/**
 * Coming out: the shape the room belonged to, around where the room's shapes were on screen as it
 * was left, just as far outside them as they sat inside it going in, so they shrink back into it.
 */
export function cameraLeaving(owner: Bounds, content: PaneRect): DraftViewport {
  const width = content.width / (1 - INSET * 2);
  const height = content.height / (1 - INSET * 2);
  // Covering them, not fitted inside them: a wide shape fitted to a tall room left the room's shapes
  // shrinking onto its edges rather than into it.
  return cameraInto(owner, {
    x: content.x - (width - content.width) / 2,
    y: content.y - (height - content.height) / 2,
    width,
    height,
  }, true);
}
