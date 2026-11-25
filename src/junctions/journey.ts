/**
 * The camera's part in following a Junction: where it stops, and how it gets there.
 *
 * Two questions, both pure arithmetic over React Flow's own `{ x, y, zoom }` camera.
 *
 * **Where** (`arrivalFrame`). Never the Junction alone in the middle of the screen: the camera
 * frames its context (`destination.ts`), so what the flow does next is on screen on arrival. The
 * zoom the person is working at is kept whenever it shows that context legibly; it changes only
 * when it has to — the context does not fit, or the names would be too small to read. A context
 * already comfortably in view is left exactly where it is.
 *
 * **How** (`journeyOf`). A short hop is a straight pan at the same zoom. A long one is one
 * continuous flight that eases out to show both ends, crosses, and eases back in (van Wijk and
 * Nuij's smooth zoom-and-pan, which is React Flow's `interpolate: 'smooth'`) — one move, not three
 * staged ones, so it reads as distance travelled rather than a cut. How long it takes follows how
 * far it goes, within limits short enough to repeat all day.
 *
 * Nothing here moves anything: `commands/junctions.ts` hands the result to the camera.
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

/** React Flow's own range (`minZoom`/`maxZoom` in `Canvas.tsx`). */
const MIN_ZOOM = 0.1;
/** Arriving closer than this makes a handful of shapes fill the screen. */
export const ARRIVAL_MAX_ZOOM = 1.2;
/** Below this, names stop being readable; a kept zoom lower than it is not a useful view. */
export const ARRIVAL_READABLE_ZOOM = 0.5;
/** Above this, a kept zoom shows too little around the Junction to explain anything. */
const ARRIVAL_KEEP_MAX_ZOOM = 1.6;
/** Air between the framed context and the edge of the usable view. */
const PADDING = 72;
/** How far inside the usable view a context must sit to count as already in view. */
const COMFORT = 32;

export type ArrivalKind = 'stay' | 'pan' | 'fit';

export interface Arrival {
  camera: DraftViewport;
  /** `stay`: nothing moves. `pan`: same zoom, new place. `fit`: the zoom changes too. */
  kind: ArrivalKind;
}

function usable(view: View, insets: Insets): Bounds {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, view.width - insets.left - insets.right),
    height: Math.max(0, view.height - insets.top - insets.bottom),
  };
}

function onScreen(box: Bounds, camera: DraftViewport): Bounds {
  return { x: box.x * camera.zoom + camera.x, y: box.y * camera.zoom + camera.y, width: box.width * camera.zoom, height: box.height * camera.zoom };
}

function inside(inner: Bounds, outer: Bounds, margin: number): boolean {
  return (
    inner.x >= outer.x + margin &&
    inner.y >= outer.y + margin &&
    inner.x + inner.width <= outer.x + outer.width - margin &&
    inner.y + inner.height <= outer.y + outer.height - margin
  );
}

function centredOn(box: Bounds, area: Bounds, zoom: number): DraftViewport {
  return {
    x: area.x + area.width / 2 - (box.x + box.width / 2) * zoom,
    y: area.y + area.height / 2 - (box.y + box.height / 2) * zoom,
    zoom,
  };
}

function fits(box: Bounds, area: Bounds, zoom: number, padding: number): boolean {
  return box.width * zoom <= area.width - padding * 2 && box.height * zoom <= area.height - padding * 2;
}

/**
 * The camera to arrive with.
 *
 * `context` is what should be on screen, `focus` the Junction itself, which must be: when the
 * context is larger than any readable zoom can show, the camera settles for the readable zoom and
 * centres on the Junction, so it is never off screen for the sake of its neighbours. A view with no
 * room (not measured yet, or all chrome) answers `stay`: moving blind is worse than not moving.
 */
export function arrivalFrame(context: Bounds, focus: Bounds, camera: DraftViewport, view: View, insets: Insets): Arrival {
  const area = usable(view, insets);
  if (area.width <= PADDING * 2 || area.height <= PADDING * 2) return { camera, kind: 'stay' };

  const useful = camera.zoom >= ARRIVAL_READABLE_ZOOM && camera.zoom <= ARRIVAL_KEEP_MAX_ZOOM;
  if (useful && inside(onScreen(context, camera), area, COMFORT)) return { camera, kind: 'stay' };
  if (useful && fits(context, area, camera.zoom, PADDING)) return { camera: centredOn(context, area, camera.zoom), kind: 'pan' };

  const ideal = Math.min((area.width - PADDING * 2) / Math.max(1, context.width), (area.height - PADDING * 2) / Math.max(1, context.height), ARRIVAL_MAX_ZOOM);
  if (ideal >= ARRIVAL_READABLE_ZOOM) return { camera: centredOn(context, area, ideal), kind: ideal === camera.zoom ? 'pan' : 'fit' };
  // Too much to show legibly: stay readable, and keep the Junction itself in the middle.
  const zoom = Math.max(MIN_ZOOM, ARRIVAL_READABLE_ZOOM);
  return { camera: centredOn(focus, area, zoom), kind: zoom === camera.zoom ? 'pan' : 'fit' };
}

/** A straight pan at one zoom, or the eased zoom-out-and-in flight. */
export type JourneyKind = 'none' | 'glide' | 'flight';

export interface Journey {
  kind: JourneyKind;
  /** Milliseconds, before the viewer's reduced-motion preference is applied. */
  duration: number;
  /** What React Flow's `setViewport` takes. */
  interpolate: 'linear' | 'smooth';
  ease: (t: number) => number;
  /**
   * How long the path is, in van Wijk and Nuij's own unit (roughly: screens crossed, with a zoom
   * change counted as distance too). What the duration is worked out from.
   */
  length: number;
}

export const GLIDE_MIN_MS = 180;
export const GLIDE_MAX_MS = 300;
export const FLIGHT_MIN_MS = 300;
export const FLIGHT_MAX_MS = 850;

/** Soft landing, quick start: a short pan should feel answered at once. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
/** Soft at both ends: a flight that starts hard reads as a lurch. */
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

const RHO = Math.SQRT2;

/**
 * The length of the smooth zoom-and-pan path between two views, each `[centre x, centre y, width]`
 * in the room's units — the `S` of van Wijk and Nuij's "Smooth and efficient zooming and panning",
 * with the same ρ = √2 `d3-interpolate`'s `interpolateZoom` uses, so the number is the length of
 * the path React Flow will actually fly.
 */
export function pathLength(from: readonly [number, number, number], to: readonly [number, number, number]): number {
  const [ux0, uy0, w0] = from;
  const [ux1, uy1, w1] = to;
  const d2 = (ux1 - ux0) ** 2 + (uy1 - uy0) ** 2;
  // Nowhere to go sideways: only the zoom changes.
  if (d2 < 1e-12) return Math.abs(Math.log(w1 / w0)) / RHO;
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO * RHO * d1);
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO * RHO * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  return (r1 - r0) / RHO;
}

/**
 * The view a camera shows, as `[centre x, centre y, size]` in the room's units. The size is the
 * pane's longer side, which is what d3-zoom flies by.
 */
function viewOf(camera: DraftViewport, view: View): [number, number, number] {
  return [(view.width / 2 - camera.x) / camera.zoom, (view.height / 2 - camera.y) / camera.zoom, Math.max(view.width, view.height) / camera.zoom];
}

/**
 * How to move the camera from `from` to `to`.
 *
 * A destination within about a screen, at about the same zoom, is a `glide`: a straight pan, which
 * never zooms for no reason. Anything further is a `flight`. Duration grows with the path's length
 * and stops growing early — the tenth jump of the morning should not cost what the first did.
 */
export function journeyOf(from: DraftViewport, to: DraftViewport, view: View): Journey {
  if (view.width <= 0 || view.height <= 0) return { kind: 'none', duration: 0, interpolate: 'linear', ease: easeOut, length: 0 };
  const start = viewOf(from, view);
  const end = viewOf(to, view);
  const moved = Math.hypot(end[0] - start[0], end[1] - start[1]);
  // In screens of the wider of the two views, so a pan while zoomed far out is not called long.
  const screens = moved / (Math.hypot(view.width, view.height) / Math.min(from.zoom, to.zoom));
  const zoomRatio = Math.max(from.zoom, to.zoom) / Math.min(from.zoom, to.zoom);
  if (moved * Math.min(from.zoom, to.zoom) < 0.5 && zoomRatio < 1.001) return { kind: 'none', duration: 0, interpolate: 'linear', ease: easeOut, length: 0 };

  const length = pathLength(start, end);
  if (screens <= 0.9 && zoomRatio <= 1.35) {
    const duration = Math.round(Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + (GLIDE_MAX_MS - GLIDE_MIN_MS) * (screens / 0.9)));
    return { kind: 'glide', duration, interpolate: 'linear', ease: easeOut, length };
  }
  const duration = Math.round(Math.min(FLIGHT_MAX_MS, Math.max(FLIGHT_MIN_MS, 200 + 130 * length)));
  return { kind: 'flight', duration, interpolate: 'smooth', ease: easeInOut, length };
}
