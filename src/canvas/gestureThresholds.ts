/**
 * How far, in screen pixels, a press must travel before it stops being a click.
 *
 * One number for every gesture that starts from a press on a shape, a connector or a handle: a click
 * has a little wobble in it, and a gesture that began on that wobble moved a shape, started a
 * connection or committed an undo step nobody asked for. The few gestures with a different number
 * say why below.
 */
export const DRAG_THRESHOLD_PX = 4;

/**
 * A press on a sketch stroke moves it once it has travelled this far. Smaller than
 * `DRAG_THRESHOLD_PX` on purpose: a stroke is thin, and a pen's wobble is smaller than a mouse's.
 */
export const INK_DRAG_THRESHOLD_PX = 3;

/**
 * A touch or pen held this long, drifting less than `LONG_PRESS_DRIFT_PX`, is a long-press — the
 * finger's right-click. 500 ms is the platforms' own hold time; 8 px is wider than a drag's
 * allowance because a held finger wobbles more than a moving one, and a slow drag must not count.
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_DRIFT_PX = 8;

// A note's or code card's capsule collapses after `CAPSULE_MOVE_THRESHOLD_PX` (6, in
// `capsuleCollapse.ts`): wider still, because grabbing a card that already rests on a shape must
// not collapse it before the pointer has clearly left where it was picked up.
