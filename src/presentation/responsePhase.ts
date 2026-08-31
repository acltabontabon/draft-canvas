/**
 * How long a step's request half animates before the reply half takes over, when the step's
 * primary edge has a `response` (see `DraftEdge.response`). Shared by the live `useFlowPlayback`
 * timer and the headless GIF planner (`export/gif.ts`) so the two can never drift apart the way
 * `PULSE_PERIOD_MS`/`TRANSITION_MS` are already flagged as fragile if hand-duplicated.
 */
export const RESPONSE_PHASE_DELAY_MS = 1300;
