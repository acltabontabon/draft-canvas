/**
 * How long a step's request half animates before the reply half takes over, when the step's
 * primary edge has a `response` (see `DraftEdge.response`). Kept in a module of its own so any
 * second reader of the timing (the retired GIF planner was one) shares this constant rather than
 * hand-duplicating it, the way `PULSE_PERIOD_MS`/`TRANSITION_MS` are already flagged as fragile.
 */
export const RESPONSE_PHASE_DELAY_MS = 1300;
