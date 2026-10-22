/**
 * A rate limit for what this copy tells the others in a session: at most one message per
 * `interval`, only when the value differs from the last one sent, and always the latest value in
 * the end — a pointer that stops moving between two ticks still arrives where it stopped.
 *
 * Pure apart from the clock it is handed, so tests drive it with a fake one.
 */

export interface Clock {
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Throttle<T> {
  /** Offers the current value: sent now if the interval allows, otherwise at its end. */
  push(value: T): void;
  /** Drops a value still waiting for its turn. */
  cancel(): void;
  /** Forgets what was last sent, so the next value goes out even if it is the same one. */
  reset(): void;
}

export function createThrottle<T>(
  send: (value: T) => void,
  same: (a: T, b: T) => boolean,
  interval: number,
  clock: Clock = SYSTEM_CLOCK,
): Throttle<T> {
  let sent: { value: T } | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let waiting: { value: T } | null = null;
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    const next = waiting;
    waiting = null;
    // A value that changed and changed back while it waited is no news.
    if (!next || (sent && same(sent.value, next.value))) return;
    sent = next;
    sentAt = clock.now();
    send(next.value);
  };

  return {
    push(value) {
      if (timer === null && sent && same(sent.value, value)) return;
      waiting = { value };
      if (timer !== null) return;
      const wait = sentAt + interval - clock.now();
      if (wait <= 0) flush();
      else timer = clock.set(flush, wait);
    },
    cancel() {
      if (timer !== null) clock.clear(timer);
      timer = null;
      waiting = null;
    },
    reset() {
      sent = null;
      sentAt = Number.NEGATIVE_INFINITY;
    },
  };
}
