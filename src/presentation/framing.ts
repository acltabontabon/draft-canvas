/**
 * The directed camera of Presentation Mode — pure rectangle arithmetic, no React Flow.
 *
 * A step is framed as a composition (its two shapes, the connector between them, the boundary
 * it crosses — see `composition.ts`), and the camera answers one question about it: does the
 * audience already see it well enough? Three answers, in order of preference:
 *
 *   `stay`  — it already sits comfortably on screen at a readable zoom: the camera does not move.
 *   `nudge` — it fits at this zoom but is partly off (or too close to the edge): the camera slides
 *             the smallest distance that brings it into the safe area, keeping the zoom, so the
 *             move reads as continuity rather than a cut.
 *   `fit`   — it is too big, too small, or too far: the camera recomposes around it, never closer
 *             than `STEP_MAX_ZOOM` (two shapes must not fill the screen) and, for a long handoff,
 *             as wide as it takes.
 *
 * The safe area is the view less the room presentation chrome needs (the control strip below, the
 * exit control above), so a framed interaction never lands under a card. Every input and output is
 * in screen pixels or React Flow's own `{ x, y, zoom }` camera, and the headless caller is free to
 * pass any view size; `useFlowPlayback.ts`'s simpler `resolveStepViewport` is the headless starting box.
 */
import type { Bounds } from '../document/geometry';
import type { DraftViewport } from '../document/types';

export interface View {
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Never closer than this on one interaction — two adjacent shapes must not fill the screen. */
export const STEP_MAX_ZOOM = 1.15;
/** The widest the closing and opening overviews go in; a two-shape flow is not a poster. */
export const OVERVIEW_MAX_ZOOM = 1;
/** React Flow's own floor (`minZoom` in `Canvas.tsx`); a frame never asks for less. */
const MIN_ZOOM = 0.1;
/** Below this, shape names stop being legible from across a room; a step still on screen at a
 *  lower zoom is reframed rather than left. */
export const READABLE_ZOOM = 0.75;
/** How far inside the safe area an interaction must sit to count as comfortably visible. */
const COMFORT_MARGIN = 28;
/** Breathing room a recomposed step keeps from the safe area's edges. */
const STEP_PADDING = 56;
/** …and an overview, which has titles to sit beside it. */
const OVERVIEW_PADDING = 64;
/** A nudge longer than this share of the safe area's diagonal is a flight, not a slide: the step
 *  is recomposed instead, so the eye gets a cut it can read rather than a pan it has to chase. */
const NUDGE_LIMIT = 0.7;
/** A recomposition whose ideal zoom is within this of the current one keeps the current zoom —
 *  a 4% zoom change is a wobble the audience notices and learns nothing from. */
const ZOOM_TOLERANCE = 0.12;

export type FrameKind = 'stay' | 'nudge' | 'fit';

export interface Frame {
  camera: DraftViewport;
  kind: FrameKind;
}

/** A flow-space box on screen under `camera`. */
export function screenRectOf(box: Bounds, camera: DraftViewport): Bounds {
  return {
    x: box.x * camera.zoom + camera.x,
    y: box.y * camera.zoom + camera.y,
    width: box.width * camera.zoom,
    height: box.height * camera.zoom,
  };
}

/** The part of the view a framed interaction may use. */
export function safeAreaOf(view: View, insets: Insets): Bounds {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, view.width - insets.left - insets.right),
    height: Math.max(0, view.height - insets.top - insets.bottom),
  };
}

function within(inner: Bounds, outer: Bounds, margin: number): boolean {
  return (
    inner.x >= outer.x + margin &&
    inner.y >= outer.y + margin &&
    inner.x + inner.width <= outer.x + outer.width - margin &&
    inner.y + inner.height <= outer.y + outer.height - margin
  );
}

/** The camera that centres `box` in `area` at `zoom`. */
function centred(box: Bounds, area: Bounds, zoom: number): DraftViewport {
  return {
    x: area.x + area.width / 2 - (box.x + box.width / 2) * zoom,
    y: area.y + area.height / 2 - (box.y + box.height / 2) * zoom,
    zoom,
  };
}

/** The zoom at which `box` fills `area` less `padding` on every side, capped at `maxZoom`. */
function fittingZoom(box: Bounds, area: Bounds, padding: number, maxZoom: number): number {
  const room = { width: Math.max(1, area.width - padding * 2), height: Math.max(1, area.height - padding * 2) };
  const zoom = Math.min(room.width / Math.max(1, box.width), room.height / Math.max(1, box.height), maxZoom);
  return Math.max(MIN_ZOOM, zoom);
}

/**
 * Where the camera should be for one step's composition `box` (flow space), given where it is now.
 * See the module comment for the three answers. A view with no room (zero size, or insets that eat
 * it) always answers `stay`: there is nothing to frame against yet, and moving blind is worse than
 * waiting for the next measurement.
 */
export function frameStep(box: Bounds, camera: DraftViewport, view: View, insets: Insets): Frame {
  const safe = safeAreaOf(view, insets);
  if (safe.width <= COMFORT_MARGIN * 2 || safe.height <= COMFORT_MARGIN * 2) return { camera, kind: 'stay' };

  const rect = screenRectOf(box, camera);
  const readable = camera.zoom >= READABLE_ZOOM;
  if (readable && within(rect, safe, COMFORT_MARGIN)) return { camera, kind: 'stay' };

  const fitsAtThisZoom =
    rect.width <= safe.width - COMFORT_MARGIN * 2 && rect.height <= safe.height - COMFORT_MARGIN * 2;
  if (readable && fitsAtThisZoom) {
    // Slide the least that brings it inside — one axis at a time, so a step just off the right edge
    // moves the camera left and nothing else.
    const dx =
      rect.x < safe.x + COMFORT_MARGIN
        ? safe.x + COMFORT_MARGIN - rect.x
        : rect.x + rect.width > safe.x + safe.width - COMFORT_MARGIN
          ? safe.x + safe.width - COMFORT_MARGIN - (rect.x + rect.width)
          : 0;
    const dy =
      rect.y < safe.y + COMFORT_MARGIN
        ? safe.y + COMFORT_MARGIN - rect.y
        : rect.y + rect.height > safe.y + safe.height - COMFORT_MARGIN
          ? safe.y + safe.height - COMFORT_MARGIN - (rect.y + rect.height)
          : 0;
    const distance = Math.hypot(dx, dy);
    if (distance <= Math.hypot(safe.width, safe.height) * NUDGE_LIMIT) {
      return { camera: { x: camera.x + dx, y: camera.y + dy, zoom: camera.zoom }, kind: 'nudge' };
    }
  }

  // Recompose. Keep the zoom the audience has already adjusted to when it is close enough to
  // ideal and the box still fits at it; otherwise take the ideal.
  const ideal = fittingZoom(box, safe, STEP_PADDING, STEP_MAX_ZOOM);
  const keepZoom =
    readable &&
    Math.abs(camera.zoom - ideal) / ideal <= ZOOM_TOLERANCE &&
    box.width * camera.zoom <= safe.width - STEP_PADDING &&
    box.height * camera.zoom <= safe.height - STEP_PADDING;
  return { camera: centred(box, safe, keepZoom ? camera.zoom : ideal), kind: 'fit' };
}

/**
 * The camera a step gets composed afresh — where `frameStep` would cut to with no camera to
 * respect: the Re-centre action, which promises a frame and not merely a verdict that the current
 * one will do.
 */
export function composeStep(box: Bounds, view: View, insets: Insets): DraftViewport {
  const safe = safeAreaOf(view, insets);
  return centred(box, safe, fittingZoom(box, safe, STEP_PADDING, STEP_MAX_ZOOM));
}

/**
 * The camera for a whole flow (the opening, the closing, and the Overview action): the flow's
 * members with their boundaries, centred in the safe area, never closer than `OVERVIEW_MAX_ZOOM`.
 */
export function frameOverview(box: Bounds, view: View, insets: Insets, maxZoom = OVERVIEW_MAX_ZOOM): DraftViewport {
  const safe = safeAreaOf(view, insets);
  const zoom = fittingZoom(box, safe, OVERVIEW_PADDING, maxZoom);
  return centred(box, safe, zoom);
}

/**
 * Whether a camera the presenter has moved by hand still shows the framed box well enough to leave
 * alone — the same test `frameStep` answers `stay` with, exposed for the moment the presenter asks
 * for guided framing back and nothing needs to move.
 */
export function comfortablyShows(box: Bounds, camera: DraftViewport, view: View, insets: Insets): boolean {
  return frameStep(box, camera, view, insets).kind === 'stay';
}

export type CaptionCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

const CORNERS: readonly CaptionCorner[] = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];

/** Where a caption of `size` sits for each corner, inside the safe area. */
export function captionBoxAt(corner: CaptionCorner, view: View, insets: Insets, size: View): Bounds {
  const safe = safeAreaOf(view, insets);
  const x = corner.endsWith('left') ? safe.x : safe.x + safe.width - size.width;
  const y = corner.startsWith('top') ? safe.y : safe.y + safe.height - size.height;
  return { x, y, width: size.width, height: size.height };
}

function overlapArea(a: Bounds, b: Bounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The corner a step caption should sit in so it covers none of the interaction — `focus` is the
 * framed box on screen. Bottom-left is the editorial default (a caption under the picture, beside
 * the strip's start); the others are tried in order and the first clear one wins, else the one that
 * covers the least. `null` focus (nothing framed) keeps the default.
 */
export function captionCornerFor(focus: Bounds | null, view: View, insets: Insets, size: View): CaptionCorner {
  if (!focus) return 'bottom-left';
  let best: CaptionCorner = 'bottom-left';
  let least = Number.POSITIVE_INFINITY;
  for (const corner of CORNERS) {
    const area = overlapArea(captionBoxAt(corner, view, insets, size), focus);
    if (area === 0) return corner;
    if (area < least) {
      least = area;
      best = corner;
    }
  }
  return best;
}
