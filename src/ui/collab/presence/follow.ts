import type { DepthPath } from '../../../depth/tree';
import type { DraftViewport } from '../../../document/types';
import type { View } from '../../../presentation/framing';

/**
 * Following the presenter — the camera half, as pure arithmetic beside `presentation/framing.ts`.
 *
 * The presenter and the people following them look through windows of different sizes, so a raw
 * React Flow camera (`{ x, y, zoom }`, measured from the top-left corner of one window) would put
 * the presenter's subject in a different place on every screen. What travels in
 * `FollowState.viewport` is therefore measured from the *centre* of the presenter's view: the same
 * zoom, and the offset of the flow origin from the middle of the window. Each follower re-anchors
 * it on the middle of their own. Presentation framing composes every step around the centre of the
 * safe area (`frameStep`), so the subject lands in the middle of every follower's screen at the
 * size the presenter chose; a larger window shows more around it, a smaller one less.
 */

/** The camera as it travels: React Flow's camera re-measured from the middle of `view`. */
export function encodeFollowViewport(camera: DraftViewport, view: View): DraftViewport {
  return { x: camera.x - view.width / 2, y: camera.y - view.height / 2, zoom: camera.zoom };
}

/**
 * The camera that shows a follower with a window of `view` what the presenter is showing. Given the
 * presenter's own window, a smaller one zooms out until all of it fits — never in: a bigger screen
 * simply shows more around the subject.
 */
export function decodeFollowViewport(shared: DraftViewport, view: View, presenterView?: View): DraftViewport {
  const scale = presenterView ? Math.min(1, view.width / presenterView.width, view.height / presenterView.height) : 1;
  return { x: shared.x * scale + view.width / 2, y: shared.y * scale + view.height / 2, zoom: shared.zoom * scale };
}

export interface FollowMotion {
  duration: number;
  /** `'linear'` slides; `'smooth'` is d3's zoom flight, which pulls back to show where it is going. */
  interpolate: 'linear' | 'smooth';
  /** A glide that starts at speed and settles, so a stream of updates reads as one motion. */
  easeOut: boolean;
}

/** Updates arrive ~10 a second; each glide outlasts the gap to the next a little, so they chain. */
const GLIDE_MS = 220;
/** A cut across the diagram — a new step framed, a different room — gets a flight it can be read in. */
const FLIGHT_MS = 520;
/** Past this share of the view's diagonal, or this zoom ratio, a move is a flight rather than a glide. */
const FLIGHT_DISTANCE = 0.6;
const FLIGHT_ZOOM_RATIO = 1.6;

/**
 * How the follower's camera gets from `current` to `target`, or `null` when it is already there.
 * Small changes — the presenter panning, the tail of their own eased move — glide; a jump flies.
 */
export function followMotion(current: DraftViewport, target: DraftViewport, view: View): FollowMotion | null {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const ratio = Math.max(target.zoom, current.zoom) / Math.max(1e-6, Math.min(target.zoom, current.zoom));
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && ratio < 1.001) return null;
  const flight = Math.hypot(dx, dy) > Math.hypot(view.width, view.height) * FLIGHT_DISTANCE || ratio > FLIGHT_ZOOM_RATIO;
  return flight
    ? { duration: FLIGHT_MS, interpolate: 'smooth', easeOut: false }
    : { duration: GLIDE_MS, interpolate: 'linear', easeOut: true };
}

/** Cubic ease-out: fast away, soft landing. */
export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * The way from room `from` to room `to`: climb out to the depth the two share, then step into each
 * room after it. `exitTo` is `null` when no climbing is needed.
 */
export function roomRoute(from: DepthPath, to: DepthPath): { exitTo: number | null; enter: string[] } {
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  return { exitTo: shared < from.length ? shared : null, enter: to.slice(shared) };
}
