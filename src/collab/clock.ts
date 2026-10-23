/**
 * Time, as the session engines see it — the real one in the app, a hand-cranked one in tests, so a
 * heartbeat timeout or a rate limit can be tested without waiting for it.
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A token bucket: `rate` tokens a second, holding at most `burst`. A message costs one token; one
 * that finds the bucket empty is over the limit. Generous enough that nobody typing, dragging or
 * pasting gets near it — it exists for a copy that sends in a loop.
 */
export class RateLimit {
  private readonly clock: Clock;
  private readonly rate: number;
  private readonly burst: number;
  private tokens: number;
  private at: number;

  constructor(clock: Clock, rate: number, burst: number) {
    this.clock = clock;
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = clock.now();
  }

  take(count = 1): boolean {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

/**
 * A byte budget per connection, checked before a message is parsed: reading is the expensive part,
 * so a peer streaming large messages is cut off by what it sends, not by what it manages to say.
 */
export class ByteBudget {
  private readonly clock: Clock;
  private readonly rate: number;
  private readonly burst: number;
  private bytes: number;
  private at: number;

  constructor(clock: Clock, bytesPerSecond: number, burst: number) {
    this.clock = clock;
    this.rate = bytesPerSecond;
    this.burst = burst;
    this.bytes = burst;
    this.at = clock.now();
  }

  spend(size: number): boolean {
    const now = this.clock.now();
    this.bytes = Math.min(this.burst, this.bytes + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (size > this.bytes) return false;
    this.bytes -= size;
    return true;
  }
}

/** Heartbeats: how often each end says it is still there, and how long silence means trouble. */
export const HEARTBEAT_MS = 5_000;
export const SILENT_MS = 15_000;
export const GONE_MS = 45_000;
/** How long a new connection has to introduce itself before it is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/**
 * How long a connection stays open after a last message (a goodbye, a refusal) before it is closed.
 * A data channel closed in the same turn may drop what was just queued on it, and the other end
 * would then see a lost connection instead of the reason.
 */
export const CLOSE_GRACE_MS = 250;
/** How often a change held back during a gesture is tried again. */
export const HOLD_RETRY_MS = 100;
/** How long a collaborator waits for the snapshot it asked for before asking again: past the owner's resync rate. */
export const RESYNC_RETRY_MS = 6_000;
