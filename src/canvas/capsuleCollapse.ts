/**
 * When a dragged Note/Code card collapses into its capsule — the pill that stands in for the
 * card while you decide where it belongs (`DragCapsule.tsx`).
 *
 * The rule is proximity, not "always": a card being repositioned on open canvas keeps its real
 * geometry, because that geometry is what the alignment guides are measured against and what
 * tells you where it will land. The capsule appears only once the aim point reaches something
 * the card could actually attach to, which makes it an affordance ("you can drop this here")
 * rather than a rendering trick — and on a crowded canvas, where you are near something almost
 * always, that amounts to "always" without having to special-case density.
 *
 * Pure and DOM-free so the timing rules below can be tested without a canvas. The caller owns
 * the geometry (what counts as `inside`/`near`); this owns only the part that a single frame
 * cannot decide — how long a state has held.
 */

/** Movement before a collapse is possible at all, in screen pixels.
 *
 *  Without it, grabbing a note that already sits on top of a shape would collapse it before the
 *  pointer had moved at all — the card would vanish on mousedown. Measured from where the grab
 *  started, so a deliberate drag crosses it within a few pixels and a click never does. */
export const CAPSULE_MOVE_THRESHOLD_PX = 6;

/** How far outside a target the aim point must get before the card comes back, in screen pixels.
 *  Plain hysteresis: entering and leaving at the same boundary would flicker along the edge. */
export const CAPSULE_RELEASE_MARGIN_PX = 24;

/** The shortest time a collapse can last. A fast pass across a lone connector should read as one
 *  soft pulse, not a strobe, so even an immediate exit holds the capsule this long. */
export const CAPSULE_MIN_COLLAPSED_MS = 150;

export interface CapsuleState {
  collapsed: boolean;
  /** When the current `collapsed` value took effect — the clock the minimum above is measured on. */
  since: number;
}

export const EXPANDED: CapsuleState = { collapsed: false, since: 0 };

export interface CapsuleProximity {
  /** The aim point is over a valid attach target right now. */
  inside: boolean;
  /** The aim point is still within the release margin of the target that caused the collapse. */
  near: boolean;
}

/**
 * The next capsule state. Collapsing is immediate (the affordance should answer the moment you
 * arrive); expanding waits for both the release margin and the minimum hold.
 */
export function nextCapsuleState(current: CapsuleState, proximity: CapsuleProximity, now: number): CapsuleState {
  if (!current.collapsed) {
    return proximity.inside ? { collapsed: true, since: now } : current;
  }
  if (proximity.inside || proximity.near) return current;
  if (now - current.since < CAPSULE_MIN_COLLAPSED_MS) return current;
  return { collapsed: false, since: now };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rect grown by `by` on every side — the release margin's own footprint. */
export function expandRect(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}
