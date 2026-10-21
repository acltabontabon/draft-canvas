import { MAX_MESSAGE_BYTES } from './chunk';
import type { CollabTransport, SendPriority, TransportState } from './types';

/**
 * Two connected in-memory transports, for exercising the sync protocol without a network.
 *
 * Delivery is always asynchronous, as a real channel's is, and in order unless a fault says
 * otherwise. Faults are drawn from a seeded generator, so a failing run replays exactly:
 *
 * - `delayMs`: each message waits this long (a `[min, max]` range jitters it, still in order);
 * - `drop`: chance a message is lost — presence only, unless `dropCommits` is set, since a real
 *   channel never loses a commit short of losing the connection;
 * - `duplicate`: chance a message arrives twice;
 * - `reorder`: chance a message is held back until the next one has gone past it;
 * - `disconnect`: chance, per message sent, that the link drops for `outageMs` (both sides go
 *   'degraded', commits queue and presence is refused, then the link restores and the queue
 *   flushes), or for good when `outageMs` is omitted (both sides close).
 *
 * The same outages can be driven by hand with `interrupt`, `restore` and `sever`.
 */

export interface LoopbackFaults {
  seed?: number;
  delayMs?: number | [number, number];
  drop?: number;
  dropCommits?: boolean;
  duplicate?: number;
  reorder?: number;
  disconnect?: number;
  outageMs?: number;
}

export interface LoopbackPair {
  readonly a: CollabTransport;
  readonly b: CollabTransport;
  /** Both sides go 'degraded' until `restore`, or for `outageMs` when given. */
  interrupt(outageMs?: number): void;
  restore(): void;
  /** Both sides close with `reason`. */
  sever(reason?: string): void;
}

/** Mulberry32: tiny, fast and good enough to make test faults reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class LoopbackEnd implements CollabTransport {
  readonly kind = 'loopback';
  current: TransportState = 'open';
  peer!: LoopbackEnd;
  private readonly link: Link;
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly stateListeners = new Set<(state: TransportState, reason?: string) => void>();

  constructor(link: Link) {
    this.link = link;
  }

  get state(): TransportState {
    return this.current;
  }

  send(message: string, priority: SendPriority): boolean {
    if (this.current === 'closed') return false;
    if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) {
      throw new RangeError(`A collaboration message may be at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    return this.link.send(this, message, priority);
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: TransportState, reason?: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  close(reason = 'closed'): void {
    if (this.current === 'closed') return;
    this.link.sever('peer-closed', this, reason);
  }

  deliver(message: string): void {
    if (this.current === 'closed') return;
    for (const listener of [...this.messageListeners]) {
      try {
        listener(message);
      } catch (error) {
        console.error(error);
      }
    }
  }

  setState(state: TransportState, reason?: string): void {
    if (this.current === state || this.current === 'closed') return;
    this.current = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state, reason);
      } catch (error) {
        console.error(error);
      }
    }
    if (state === 'closed') {
      this.messageListeners.clear();
      this.stateListeners.clear();
    }
  }
}

interface Pending {
  to: LoopbackEnd;
  message: string;
}

class Link {
  readonly a: LoopbackEnd;
  readonly b: LoopbackEnd;
  private readonly faults: LoopbackFaults;
  private readonly random: () => number;
  private down = false;
  private closed = false;
  /** Commits sent while the link was down, delivered in order once it restores. */
  private held: Pending[] = [];
  /** A message the reorder fault is holding until the next one overtakes it. */
  private lagging: Pending | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private outageTimer: ReturnType<typeof setTimeout> | null = null;
  /** Messages in flight, per receiving end, in due order: one queue each, so jitter never reorders. */
  private readonly inFlight = new Map<LoopbackEnd, { due: number; pending: Pending }[]>();

  constructor(faults: LoopbackFaults) {
    this.faults = faults;
    this.random = seededRandom(faults.seed ?? 1);
    this.a = new LoopbackEnd(this);
    this.b = new LoopbackEnd(this);
    this.a.peer = this.b;
    this.b.peer = this.a;
  }

  send(from: LoopbackEnd, message: string, priority: SendPriority): boolean {
    const pending = { to: from.peer, message };
    if (this.down) {
      if (priority === 'presence') return false;
      this.held.push(pending);
      return true;
    }
    if (this.chance(this.faults.disconnect)) {
      if (this.faults.outageMs === undefined) {
        this.sever('disconnected');
        return false;
      }
      this.interrupt(this.faults.outageMs);
      return this.send(from, message, priority);
    }
    if ((priority === 'presence' || this.faults.dropCommits) && this.chance(this.faults.drop)) {
      return priority === 'commit';
    }
    const copies = this.chance(this.faults.duplicate) ? 2 : 1;
    for (let i = 0; i < copies; i++) this.route(pending);
    return true;
  }

  interrupt(outageMs?: number): void {
    if (this.closed) return;
    this.down = true;
    // Whatever is in flight waits out the outage too, ahead of what is sent during it. A held-back
    // message was the last one sent in its direction, so it goes last.
    for (const queue of this.inFlight.values()) this.held.push(...queue.splice(0).map(({ pending }) => pending));
    if (this.lagging) this.held.push(this.lagging);
    this.lagging = null;
    this.a.setState('degraded', 'disconnected');
    this.b.setState('degraded', 'disconnected');
    if (this.outageTimer !== null) clearTimeout(this.outageTimer);
    this.outageTimer = outageMs === undefined ? null : setTimeout(() => {
      this.outageTimer = null;
      this.restore();
    }, outageMs);
  }

  restore(): void {
    if (this.closed || !this.down) return;
    this.down = false;
    if (this.outageTimer !== null) clearTimeout(this.outageTimer);
    this.outageTimer = null;
    this.a.setState('open');
    this.b.setState('open');
    for (const pending of this.held.splice(0)) this.schedule(pending);
  }

  sever(reason = 'closed', initiator?: LoopbackEnd, initiatorReason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.outageTimer !== null) clearTimeout(this.outageTimer);
    this.outageTimer = null;
    this.held = [];
    this.lagging = null;
    this.inFlight.clear();
    for (const end of [this.a, this.b]) end.setState('closed', end === initiator ? initiatorReason : reason);
  }

  private route(pending: Pending): void {
    if (this.lagging) {
      const overtaken = this.lagging;
      this.lagging = null;
      this.schedule(pending);
      this.schedule(overtaken);
      return;
    }
    if (this.chance(this.faults.reorder)) {
      this.lagging = pending;
      // Nothing else may ever be sent; the held message still arrives, just late.
      this.after(this.delay() + 50, () => {
        if (this.lagging !== pending) return;
        this.lagging = null;
        this.schedule(pending);
      });
      return;
    }
    this.schedule(pending);
  }

  private schedule(pending: Pending): void {
    let queue = this.inFlight.get(pending.to);
    if (!queue) this.inFlight.set(pending.to, (queue = []));
    const due = Math.max(Date.now() + this.delay(), queue.at(-1)?.due ?? 0);
    queue.push({ due, pending });
    if (queue.length === 1) this.arm(pending.to);
  }

  private arm(to: LoopbackEnd): void {
    const head = this.inFlight.get(to)?.[0];
    if (!head) return;
    const wait = head.due - Date.now();
    // A microtask when nothing is delayed, so loopback tests need no fake clock to see delivery.
    if (wait <= 0) {
      queueMicrotask(() => {
        if (!this.closed) this.drain(to);
      });
    } else {
      this.after(wait, () => this.drain(to));
    }
  }

  private drain(to: LoopbackEnd): void {
    const queue = this.inFlight.get(to);
    if (!queue) return;
    const now = Date.now();
    while (queue[0] && queue[0].due <= now && !this.down && !this.closed) {
      to.deliver(queue.shift()!.pending.message);
    }
    if (!this.down && !this.closed) this.arm(to);
  }

  private after(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) run();
    }, ms);
    this.timers.add(timer);
  }

  private delay(): number {
    const { delayMs } = this.faults;
    if (delayMs === undefined) return 0;
    if (typeof delayMs === 'number') return delayMs;
    return delayMs[0] + this.random() * (delayMs[1] - delayMs[0]);
  }

  private chance(probability: number | undefined): boolean {
    return probability !== undefined && probability > 0 && this.random() < probability;
  }
}

export function createLoopbackPair(faults: LoopbackFaults = {}): LoopbackPair {
  const link = new Link(faults);
  return {
    a: link.a,
    b: link.b,
    interrupt: (outageMs) => link.interrupt(outageMs),
    restore: () => link.restore(),
    sever: (reason) => link.sever(reason),
  };
}
