import { MAX_MESSAGE_BYTES } from './chunk';
import type { CollabTransport, SendPriority, TransportState } from './types';

/**
 * The owner's side of the desktop app's LAN relay. The shell (`src-tauri/src/collab/`) holds the
 * sockets; the page hears each guest as `collab-lan-*` events and answers through two commands.
 * This turns every relay connection into a `CollabTransport` the host session can attach like any
 * other, and knows nothing of Tauri: the commands are injected.
 *
 * Each command is a separate IPC call, and the shell runs them concurrently, so two sends in flight
 * at once could reach a guest in either order. Sends to one guest therefore go one at a time, in
 * order; a close waits for everything already sent to have been handed over. Presence is dropped
 * once a small backlog has built up; commits are never dropped, and a backlog that stays for 5 s
 * marks the transport 'degraded' (the shell itself closes a guest that stops reading, `congested`).
 *
 * Close reasons, as `onState` reports them: the shell's (`closed`, `timeout`, `congested`,
 * `too-large`, `binary`, `error`, `token-changed`, `server-stopped`), the relay's own stop reason
 * (`stopped`, `window-closed`, `reload`), `send-failed`, `queue-overflow`, or whatever the session
 * passed to `close`.
 */

export type LanRelayEvent =
  | { type: 'collab-lan-open'; connId: string }
  | { type: 'collab-lan-message'; connId: string; text: string }
  | { type: 'collab-lan-close'; connId: string; reason: string }
  | { type: 'collab-lan-stopped'; reason: string };

/** The two commands a connection needs: `DesktopApi.collabLanSend` and `collabLanClose`. */
export interface LanRelayLink {
  send(connId: string, text: string): Promise<void>;
  close(connId: string, reason: string): Promise<void>;
}

export interface LanHostClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LanHostHandlers {
  /** A guest's connection, open and authenticated by the relay; its first message is its hello. */
  connection(transport: CollabTransport): void;
  /** The relay stopped by itself or was stopped; every connection has closed. */
  stopped?(reason: string): void;
}

/** Above this many bytes waiting for one guest, presence is dropped. */
export const LAN_PRESENCE_BACKLOG_BYTES = 64 * 1024;
export const LAN_DEGRADE_MS = 5_000;
/** Matches the shell's own per-guest queue limit; past it the guest isn't reading at all. */
export const LAN_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

const realClock: LanHostClock = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const encoder = new TextEncoder();

/** Exact UTF-8 bytes near the cap, where it decides; the length below, where it is only accounting. */
function messageBytes(text: string): number {
  if (text.length * 3 <= MAX_MESSAGE_BYTES || text.length > MAX_MESSAGE_BYTES) return text.length;
  return encoder.encode(text).byteLength;
}

class LanConnection implements CollabTransport {
  readonly kind = 'socket';
  private current: TransportState = 'open';
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly stateListeners = new Set<(state: TransportState, reason?: string) => void>();
  private queue: { text: string; bytes: number }[] = [];
  private head = 0;
  private backlogBytes = 0;
  private sending = false;
  /** Set once the session closed this: the relay is told after the backlog has been handed over. */
  private closing: string | null = null;
  /** Set once the relay closed it: nothing left is worth sending. */
  private gone = false;
  private degradeTimer: unknown = null;
  private congested = false;

  readonly connId: string;
  private readonly link: LanRelayLink;
  private readonly clock: LanHostClock;
  private readonly forget: (connection: LanConnection) => void;

  constructor(connId: string, link: LanRelayLink, clock: LanHostClock, forget: (connection: LanConnection) => void) {
    this.connId = connId;
    this.link = link;
    this.clock = clock;
    this.forget = forget;
  }

  get state(): TransportState {
    return this.current;
  }

  send(message: string, priority: SendPriority): boolean {
    if (this.current === 'closed') return false;
    const bytes = messageBytes(message);
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new RangeError(`A collaboration message may be at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    if (priority === 'presence' && (this.congested || this.backlogBytes > LAN_PRESENCE_BACKLOG_BYTES)) return false;
    this.queue.push({ text: message, bytes });
    this.backlogBytes += bytes;
    if (this.backlogBytes > LAN_MAX_QUEUED_BYTES) {
      this.close('queue-overflow');
      return false;
    }
    this.pump();
    return true;
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: TransportState, reason?: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The session is done with this guest. What it already sent (a goodbye) still goes first. */
  close(reason = 'closed'): void {
    if (this.current === 'closed') return;
    this.closing = reason;
    this.finish(reason);
    if (reason === 'queue-overflow') this.dropBacklog();
    this.pump();
  }

  /** The relay says this guest is gone. */
  closedByRelay(reason: string): void {
    this.gone = true;
    this.dropBacklog();
    if (this.current !== 'closed') this.finish(reason);
  }

  deliver(text: string): void {
    if (this.current === 'closed') return;
    for (const listener of [...this.messageListeners]) {
      try {
        listener(text);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private pump(): void {
    if (this.sending || this.gone) return;
    const entry = this.queue[this.head];
    if (!entry) {
      this.queue = [];
      this.head = 0;
      this.settle();
      if (this.closing !== null) {
        const reason = this.closing;
        this.closing = null;
        this.gone = true;
        void this.call(() => this.link.close(this.connId, reason)).catch((error: unknown) => console.error(error));
      }
      return;
    }
    this.head++;
    this.sending = true;
    this.watchBacklog();
    this.call(() => this.link.send(this.connId, entry.text)).then(
      () => {
        this.sending = false;
        // Still counted while in flight; a backlog dropped meanwhile was already zeroed.
        this.backlogBytes = Math.max(0, this.backlogBytes - entry.bytes);
        if (this.gone) return;
        if (this.head > 1024 && this.head * 2 > this.queue.length) {
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
        this.pump();
      },
      (error: unknown) => {
        this.sending = false;
        if (this.gone) return;
        // A message the guest never got leaves it out of step with the file: it must start over.
        console.error(error);
        this.dropBacklog();
        if (this.current !== 'closed') this.finish('send-failed');
        this.gone = true;
        void this.call(() => this.link.close(this.connId, 'send-failed')).catch(() => {});
      },
    );
  }

  private call(run: () => Promise<void>): Promise<void> {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private watchBacklog(): void {
    if (this.degradeTimer !== null || this.congested || this.current === 'closed') return;
    this.degradeTimer = this.clock.setTimeout(() => {
      this.degradeTimer = null;
      if (this.current === 'closed' || (!this.sending && this.head >= this.queue.length)) return;
      this.congested = true;
      this.setState('degraded', 'congested');
    }, LAN_DEGRADE_MS);
  }

  /** The backlog is empty: no longer congested. */
  private settle(): void {
    if (this.degradeTimer !== null) this.clock.clearTimeout(this.degradeTimer);
    this.degradeTimer = null;
    if (this.congested) {
      this.congested = false;
      if (this.current !== 'closed') this.setState('open');
    }
  }

  private dropBacklog(): void {
    this.queue = [];
    this.head = 0;
    this.backlogBytes = 0;
    if (this.degradeTimer !== null) this.clock.clearTimeout(this.degradeTimer);
    this.degradeTimer = null;
  }

  private finish(reason: string): void {
    this.forget(this);
    this.setState('closed', reason);
    this.messageListeners.clear();
    this.stateListeners.clear();
  }

  private setState(state: TransportState, reason?: string): void {
    if (state === this.current) return;
    this.current = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state, reason);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/** Routes the relay's events to one transport per guest. Feed it every `collab-lan-*` event. */
export class LanHostRelay {
  private readonly connections = new Map<string, LanConnection>();
  private readonly link: LanRelayLink;
  private readonly handlers: LanHostHandlers;
  private readonly clock: LanHostClock;

  constructor(link: LanRelayLink, handlers: LanHostHandlers, clock: LanHostClock = realClock) {
    this.link = link;
    this.handlers = handlers;
    this.clock = clock;
  }

  /** Guests connected right now. */
  get size(): number {
    return this.connections.size;
  }

  handle(event: LanRelayEvent): void {
    switch (event.type) {
      case 'collab-lan-open': {
        // The shell never reuses an id; a repeat would mean the old connection is gone.
        this.connections.get(event.connId)?.closedByRelay('closed');
        const connection = new LanConnection(event.connId, this.link, this.clock, (done) => {
          if (this.connections.get(done.connId) === done) this.connections.delete(done.connId);
        });
        this.connections.set(event.connId, connection);
        this.handlers.connection(connection);
        return;
      }
      case 'collab-lan-message':
        this.connections.get(event.connId)?.deliver(event.text);
        return;
      case 'collab-lan-close':
        this.connections.get(event.connId)?.closedByRelay(event.reason);
        return;
      case 'collab-lan-stopped':
        this.closeAll(event.reason);
        this.handlers.stopped?.(event.reason);
        return;
    }
  }

  /** Every connection closes with `reason`, as if the relay had closed it (it is stopping). */
  closeAll(reason: string): void {
    for (const connection of [...this.connections.values()]) connection.closedByRelay(reason);
    this.connections.clear();
  }
}
