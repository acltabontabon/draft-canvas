/**
 * Every number that decides what Smart Ink does with a drawing, in one place and with its unit —
 * they mix three, and which one a number is in decides how it behaves when the person zooms.
 *
 * - **Screen pixels** are what the person sees: a stroke is judged at the size it was drawn on
 *   screen, so zooming in or out does not change what a stroke of that size means (`recognize.ts`
 *   resamples by `scale` first, and `interpret.ts` divides its reaches by it).
 * - **Room units** are the diagram's own: a box is "large" or a circle "small" by what it will be on
 *   the canvas, not by how it was drawn. Drawn at the same size on screen, the same circle is therefore
 *   a Junction at one zoom and a Component at another, because what it would become changed size. That
 *   is the point of the rule — a Junction is meant to be small *in the diagram* — and not a defect.
 * - **Milliseconds** are timing.
 *
 * Nothing here is configurable: a threshold a person tuned would make the same drawing mean
 * different things on two machines.
 */

// ---- Confidence (unitless, 0 to 1) -----------------------------------------------------------

/** At or above this, a drawing is converted as it is drawn. */
export const CONVERT_CONFIDENCE = 0.6;
/** At or above this (and below `CONVERT_CONFIDENCE`), it is only offered. */
export const OFFER_CONFIDENCE = 0.38;
/** "Convert to shape" on strokes already drawn accepts a reading this fraction as sure as an offer. */
export const FORCED_OFFER_FRACTION = 0.6;

// ---- Screen pixels ---------------------------------------------------------------------------

/** Resampling step: dense enough for coverage bins, sparse enough to be cheap. */
export const RESAMPLE_STEP_PX = 3;
/** A drawing whose diagonal is smaller than this is a dot or a tick, never a shape. */
export const MIN_DIAGONAL_PX = 18;
/** How far short of, or past, a shape a line's end may land and still mean it: a hand is not exact. */
export const END_REACH_PX = 14;
/** How far a drawn box may miss the edge of a shape it goes round and still enclose it. */
export const ENCLOSE_TOLERANCE_PX = 6;
/** A stroke that starts this close to the drawing in progress continues it (or, at least,
 *  `CONTINUES_FRACTION` of its larger side — whichever is further). */
export const CONTINUES_WITHIN_PX = 28;

// ---- Room units ------------------------------------------------------------------------------

/** A box at least this large, drawn in empty space, is offered as a Boundary first. */
export const LARGE_BOX = { width: 300, height: 190 } as const;
/** A circle whose larger side is at most this is the punctuation connectors meet at (a Junction), not a participant. */
export const SMALL_CIRCLE = 52;

// ---- Proportions (unitless) ------------------------------------------------------------------

/** A stroke within this fraction of the drawing's larger side also continues it (see `CONTINUES_WITHIN_PX`). */
export const CONTINUES_FRACTION = 0.25;

// ---- Milliseconds ----------------------------------------------------------------------------

/** How long the pen may rest before a drawing counts as finished and is read. */
export const SETTLE_MS = 650;
/** How long a converted drawing's strokes take to fade out as its shape fades in. */
export const RESOLVE_MS = 260;
