/**
 * When to record a revision: the checkpoint scheduler, as a pure state machine with an injected
 * clock, so every rule below is a unit test rather than a hope (`tests/evolution/scheduler.test.ts`).
 *
 * - A low-level mutation (every `revision` bump: each frame of a drag, each keystroke) only marks
 *   the working copy dirty. It never records anything by itself.
 * - A revision is recorded at a **boundary** — no gesture held — once editing has been idle for
 *   `idleMs` (30 s by default), or after `maxMs` (120 s) of sustained editing, whichever comes first.
 *   Due while a drag, resize or stroke is held, it waits for the gesture to end instead of recording
 *   a half-finished state.
 * - Agent edits are coalesced at their reviewed batch: they mark dirty like any edit, and the
 *   batch's end (`settle`) is what makes them due, so an agent applying ten related edits records
 *   one revision, not ten.
 * - One capture at a time. Edits while it runs stay pending and arm the next one.
 * - A failed capture retries with backoff (2 s, doubling, at most 5 min), and never blocks editing.
 * - Whether a due capture records anything is not decided here: equal content records nothing.
 */

export interface SchedulerConfig {
  idleMs: number;
  maxMs: number;
  /** How soon to look again when due during a gesture. */
  boundaryRetryMs: number;
  /** Agent batches settle after this much agent quiet. */
  agentQuietMs: number;
}

export const DEFAULT_SCHEDULE: SchedulerConfig = { idleMs: 30_000, maxMs: 120_000, boundaryRetryMs: 500, agentQuietMs: 3_000 };

export interface SchedulerState {
  /** When the oldest edit not yet recorded happened, or `null` when nothing is pending. */
  dirtySince: number | null;
  lastEditAt: number | null;
  /** The newest edit's generation (`editorStore.revision` in its load epoch). */
  generation: number;
  /** The generation the running capture snapshotted, or `null` when none runs. */
  inFlight: number | null;
  /** An explicit request (agent batch end, lifecycle, "capture now") is waiting for a boundary. */
  requested: boolean;
  /** An agent batch is open: its edits wait for `settle`. */
  agentOpenAt: number | null;
  failures: number;
  retryAt: number | null;
}

export const IDLE_STATE: SchedulerState = { dirtySince: null, lastEditAt: null, generation: 0, inFlight: null, requested: false, agentOpenAt: null, failures: 0, retryAt: null };

export type SchedulerEvent =
  | { kind: 'edit'; at: number; generation: number; agent?: boolean }
  | { kind: 'request'; at: number }
  | { kind: 'agent-settled'; at: number }
  | { kind: 'started'; at: number; generation: number }
  | { kind: 'succeeded'; at: number }
  | { kind: 'failed'; at: number }
  /** The working copy was loaded fresh (open, switch, restore): pending reflects only what follows. */
  | { kind: 'reset'; at: number; generation: number; dirty: boolean };

export function step(state: SchedulerState, event: SchedulerEvent): SchedulerState {
  switch (event.kind) {
    case 'edit':
      return {
        ...state,
        dirtySince: state.dirtySince ?? event.at,
        lastEditAt: event.at,
        generation: Math.max(state.generation, event.generation),
        agentOpenAt: event.agent ? event.at : state.agentOpenAt,
      };
    case 'request':
      return { ...state, requested: true };
    case 'agent-settled':
      return { ...state, agentOpenAt: null, requested: state.dirtySince !== null || state.requested };
    case 'started':
      return { ...state, inFlight: event.generation, requested: false };
    case 'succeeded': {
      const captured = state.inFlight ?? state.generation;
      const stillDirty = state.generation > captured;
      return {
        ...state,
        inFlight: null,
        failures: 0,
        retryAt: null,
        // Edits made while it ran are still pending, from when the capture finished.
        dirtySince: stillDirty ? event.at : null,
        lastEditAt: stillDirty ? state.lastEditAt : null,
      };
    }
    case 'failed': {
      const failures = state.failures + 1;
      const backoff = Math.min(300_000, 2_000 * 2 ** (failures - 1));
      return { ...state, inFlight: null, failures, retryAt: event.at + backoff };
    }
    case 'reset':
      return { ...IDLE_STATE, generation: event.generation, dirtySince: event.dirty ? event.at : null, lastEditAt: event.dirty ? event.at : null };
  }
}

export type Decision = { kind: 'idle' } | { kind: 'wait'; until: number } | { kind: 'capture' };

/**
 * What to do at `now`. `atBoundary` is false while a gesture is held. A `wait` says when to ask
 * again; `capture` means start one now (and report `started`).
 */
export function decide(state: SchedulerState, now: number, atBoundary: boolean, config: SchedulerConfig = DEFAULT_SCHEDULE): Decision {
  if (state.inFlight !== null) return { kind: 'idle' };
  if (state.dirtySince === null && !state.requested) return { kind: 'idle' };
  if (state.retryAt !== null && now < state.retryAt) return { kind: 'wait', until: state.retryAt };
  // An open agent batch holds its edits until it settles — unless sustained editing ran past the
  // maximum, which no batch is allowed to defer.
  const agentHolding = state.agentOpenAt !== null && now - state.agentOpenAt < config.agentQuietMs;
  let dueAt: number;
  if (state.requested && !agentHolding) dueAt = now;
  else if (state.dirtySince === null) return { kind: 'idle' };
  else {
    const idleDue = (state.lastEditAt ?? state.dirtySince) + config.idleMs;
    const maxDue = state.dirtySince + config.maxMs;
    dueAt = Math.min(maxDue, agentHolding ? Math.max(idleDue, state.agentOpenAt! + config.agentQuietMs) : idleDue);
  }
  if (now < dueAt) return { kind: 'wait', until: dueAt };
  if (!atBoundary) return { kind: 'wait', until: now + config.boundaryRetryMs };
  return { kind: 'capture' };
}

/** Whether there are edits not yet recorded. */
export function isPending(state: SchedulerState): boolean {
  return state.dirtySince !== null || state.inFlight !== null;
}
