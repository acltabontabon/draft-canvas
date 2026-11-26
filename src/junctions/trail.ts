/**
 * Where following Junctions has taken you, so you can go back.
 *
 * A browser's history, for one diagram: a list of places and which one you are at. Following a
 * Junction records where you left from, drops any places ahead (you went somewhere new), and adds
 * where you arrive. Back and forward move along the list, and write down where the camera was as
 * you leave a place, so coming back to it puts you exactly where you were.
 *
 * It is navigation and nothing else: session-local, bounded, never saved, never undone, never
 * shared, and it never touches the document. Pure: each function returns the next trail.
 */
import type { DraftViewport } from '../document/types';
import { samePath, type DepthPath } from '../depth/tree';

/** How many places are remembered; the oldest are forgotten first. */
export const TRAIL_LIMIT = 50;

export interface TrailStop {
  /** The room, as owner node ids from the file inward. */
  path: DepthPath;
  /** The camera there. */
  camera: DraftViewport;
  /** The Junction that was followed from here, or arrived at — what to point out on return. */
  junctionId?: string;
  /** How the place is named in the controls: "A · Payment Execution". */
  label: string;
}

export interface Trail {
  /** The diagram the trail belongs to. A trail read against any other diagram is empty. */
  documentId: string | null;
  stops: readonly TrailStop[];
  /** Where you are in `stops`; `-1` when there are none. */
  index: number;
}

export const EMPTY_TRAIL: Trail = Object.freeze({ documentId: null, stops: Object.freeze([]) as readonly TrailStop[], index: -1 });

/** The trail as it applies to `documentId`: itself, or empty when it was laid in another diagram. */
function forDocument(trail: Trail, documentId: string): Trail {
  return trail.documentId === documentId ? trail : { documentId, stops: [], index: -1 };
}

/**
 * Records one journey: leaving `from`, arriving at `to`.
 *
 * `from` replaces the place you were at (the camera may have moved since you arrived there), unless
 * you had wandered to another room, in which case it is a new place after it. Anything ahead is
 * dropped, as in any history: forward only ever means "back to where I just came from".
 */
export function travel(trail: Trail, documentId: string, from: TrailStop, to: TrailStop): Trail {
  const current = forDocument(trail, documentId);
  const kept = current.stops.slice(0, current.index + 1);
  const here = kept[kept.length - 1];
  if (here && samePath(here.path, from.path)) kept[kept.length - 1] = from;
  else kept.push(from);
  kept.push(to);
  const stops = kept.length > TRAIL_LIMIT ? kept.slice(kept.length - TRAIL_LIMIT) : kept;
  return { documentId, stops, index: stops.length - 1 };
}

export function canGoBack(trail: Trail, documentId: string): boolean {
  return trail.documentId === documentId && trail.index > 0;
}

export function canGoForward(trail: Trail, documentId: string): boolean {
  return trail.documentId === documentId && trail.index >= 0 && trail.index < trail.stops.length - 1;
}

/** The place back (`-1`) or forward (`1`) would go to, without going. */
export function peekStop(trail: Trail, documentId: string, direction: -1 | 1): TrailStop | undefined {
  if (trail.documentId !== documentId) return undefined;
  return trail.stops[trail.index + direction];
}

export interface Step {
  trail: Trail;
  /** Where to go. */
  stop: TrailStop;
}

/**
 * Moves one place along the trail. `here` is where the camera is as you leave: it is written on the
 * place you are leaving, so the opposite step returns to this exact view. `null` at either end.
 */
export function step(trail: Trail, documentId: string, direction: -1 | 1, here: Pick<TrailStop, 'path' | 'camera'>): Step | null {
  if (trail.documentId !== documentId) return null;
  const target = trail.stops[trail.index + direction];
  const leaving = trail.stops[trail.index];
  if (!target || !leaving) return null;
  const stops = trail.stops.slice();
  // Only when still in that place's room: a camera from another room would mean nothing there.
  if (samePath(leaving.path, here.path)) stops[trail.index] = { ...leaving, camera: here.camera };
  return { trail: { documentId, stops, index: trail.index + direction }, stop: target };
}

/**
 * The trail without a place that turned out to be gone (its room was deleted). The position moves
 * so that it still names the place you are actually at.
 */
export function withoutStop(trail: Trail, gone: TrailStop): Trail {
  const at = trail.stops.indexOf(gone);
  if (at < 0) return trail;
  const stops = trail.stops.filter((stop) => stop !== gone);
  if (stops.length === 0) return { documentId: trail.documentId, stops, index: -1 };
  const index = Math.min(stops.length - 1, at <= trail.index ? Math.max(0, trail.index - 1) : trail.index);
  return { documentId: trail.documentId, stops, index };
}
