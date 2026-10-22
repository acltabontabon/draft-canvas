import { MAX_MESSAGE_BYTES } from './chunk';
import type { CollabTransport, SendPriority, TransportState } from './types';

/**
 * A collaborator's connection to the desktop app's LAN relay (`src-tauri/src/collab/`): one browser
 * WebSocket to `/collab` on the address the page itself was served from, offering two subprotocols,
 * `draft-canvas.collab.v1` and the session's token. The relay refuses the upgrade without both, so a
 * wrong or stale token never opens — the browser only sees the connection fail.
 *
 * Each application message is one text frame; the relay never sends binary, and anything that is
 * not text is ignored. Messages sent while the socket is still connecting wait for it to open.
 * Presence is best-effort: dropped unless the socket is open, nothing is waiting and the browser's
 * own buffer is below a low watermark. Commits are never dropped; they wait in order until the buffer
 * drains, and a backlog that stays for 5 s marks the transport 'degraded' until it clears.
 *
 * Close reasons, as `onState` reports them: the relay's own (`timeout`, `congested`, `too-large`,
 * `token-changed`, `server-stopped`, or what the owner's session closed it with), `unreachable` (it
 * never opened: wrong address, stale link, or the owner stopped sharing), `connection-lost`,
 * `connect-timeout`, `protocol`, `queue-overflow`, or whatever the caller passed to `close`.
 * Degraded reason: `congested`.
 */

export const LAN_PROTOCOL = 'draft-canvas.collab.v1';
export const LAN_SOCKET_PATH = '/collab';
/** A LAN answers in milliseconds; a machine that has gone to sleep never answers at all. */
export const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
export const SOCKET_DEGRADE_MS = 5_000;
/** Above this many buffered bytes presence is dropped. */
export const SOCKET_LOW_WATERMARK = 256 * 1024;
/** Commits stop being handed to the socket above this, so the browser's own buffer stays bounded. */
export const SOCKET_HIGH_WATERMARK = 1024 * 1024;
/** Unsent commits past this mean nothing is getting through; holding more would only grow. */
export const SOCKET_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
/** WebSocket has no "buffer drained" event, so a backlog is checked this often until it clears. */
const DRAIN_POLL_MS = 50;
/** A close frame's reason is at most 123 bytes of UTF-8. */
const MAX_CLOSE_REASON_BYTES = 123;

/** The parts of the browser's WebSocket this uses, so tests can pass a fake. */
export interface SocketLike extends EventTarget {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface SocketClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SocketTransportOptions {
  /** Makes the socket. Defaults to the browser's WebSocket. */
  socket?: SocketFactory;
  clock?: SocketClock;
}

const OPEN = 1;

const realClock: SocketClock = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const browserSocket: SocketFactory = (url, protocols) => new WebSocket(url, protocols);

const encoder = new TextEncoder();

/**
 * What `text` counts as against the limits: exact UTF-8 bytes near the cap, where it decides; its
 * length below, where it only feeds the backlog's accounting and encoding every pointer move would
 * be waste. Past the cap in UTF-16 units it is past it in bytes too.
 */
function messageBytes(text: string): number {
  if (text.length * 3 <= MAX_MESSAGE_BYTES || text.length > MAX_MESSAGE_BYTES) return text.length;
  return encoder.encode(text).byteLength;
}

/** `reason` cut to what a close frame carries, never splitting a character. */
export function closeReason(reason: string): string {
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let cut = '';
  for (const char of reason) {
    if (encoder.encode(cut + char).byteLength > MAX_CLOSE_REASON_BYTES) break;
    cut += char;
  }
  return cut;
}

/** The relay's socket URL on the page's own address: `wss:` under https, `ws:` otherwise. */
export function lanSocketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${LAN_SOCKET_PATH}`;
}

class SocketTransport implements CollabTransport {
  readonly kind = 'socket';
  private current: TransportState = 'connecting';
  private readonly socket: SocketLike;
  private readonly clock: SocketClock;
  private readonly lifetime = new AbortController();
  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly stateListeners = new Set<(state: TransportState, reason?: string) => void>();
  /** Commits waiting for the socket to open or its buffer to drain, oldest first, from `head`. */
  private queue: { text: string; bytes: number }[] = [];
  private head = 0;
  private queuedBytes = 0;
  private everOpen = false;
  private congested = false;
  private connectTimer: unknown = null;
  private drainTimer: unknown = null;
  private degradeTimer: unknown = null;

  constructor(url: string, token: string, options: SocketTransportOptions) {
    this.clock = options.clock ?? realClock;
    this.socket = (options.socket ?? browserSocket)(url, [LAN_PROTOCOL, token]);
    const listen = { signal: this.lifetime.signal };
    this.socket.addEventListener('open', () => this.onOpen(), listen);
    this.socket.addEventListener('message', (event) => this.onFrame(event as MessageEvent), listen);
    this.socket.addEventListener('close', (event) => this.onClose(event as CloseEvent), listen);
    // 'error' carries nothing a page may read, and a 'close' always follows it.
    this.connectTimer = this.clock.setTimeout(() => {
      this.connectTimer = null;
      this.close('connect-timeout');
    }, SOCKET_CONNECT_TIMEOUT_MS);
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
    if (priority === 'presence') {
      if (!this.canSendPresence()) return false;
      try {
        this.socket.send(message);
        return true;
      } catch {
        return false;
      }
    }
    this.queue.push({ text: message, bytes });
    this.queuedBytes += bytes;
    if (this.queuedBytes > SOCKET_MAX_QUEUED_BYTES) {
      this.close('queue-overflow');
      return false;
    }
    this.pump();
    return this.state !== 'closed';
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
    this.release();
    try {
      // Only 1000 and 3000–4999 may be sent by a page; the reason says the rest.
      this.socket.close(1000, closeReason(reason));
    } catch {
      /* Already closing. */
    }
    this.finish(reason);
  }

  private canSendPresence(): boolean {
    return (
      this.current === 'open' &&
      this.socket.readyState === OPEN &&
      this.head >= this.queue.length &&
      this.socket.bufferedAmount <= SOCKET_LOW_WATERMARK
    );
  }

  private onOpen(): void {
    if (this.current === 'closed') return;
    if (this.connectTimer !== null) this.clock.clearTimeout(this.connectTimer);
    this.connectTimer = null;
    // The relay answers with exactly the protocol it was offered; anything else isn't the relay.
    if (this.socket.protocol !== LAN_PROTOCOL) return this.close('protocol');
    this.everOpen = true;
    this.setState('open');
    this.pump();
  }

  private onFrame(event: MessageEvent): void {
    if (this.current === 'closed' || typeof event.data !== 'string') return;
    for (const listener of [...this.messageListeners]) {
      try {
        listener(event.data);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private onClose(event: CloseEvent): void {
    if (this.current === 'closed') return;
    this.release();
    const reason = event.reason || (this.everOpen ? (event.code === 1009 ? 'too-large' : 'connection-lost') : 'unreachable');
    this.finish(reason);
  }

  private pump(): void {
    if (this.current === 'closed' || this.socket.readyState !== OPEN || !this.everOpen) return;
    while (this.head < this.queue.length && this.socket.bufferedAmount <= SOCKET_HIGH_WATERMARK) {
      const entry = this.queue[this.head]!;
      try {
        this.socket.send(entry.text);
      } catch {
        // The socket is closing: its 'close' event decides what happens next.
        return;
      }
      this.head++;
      this.queuedBytes -= entry.bytes;
    }
    if (this.head >= this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    this.watchBacklog();
  }

  /** Polls while anything is waiting or buffered past the low mark; degrades if it stays stuck. */
  private watchBacklog(): void {
    const waiting = this.head < this.queue.length;
    const backedUp = waiting || this.socket.bufferedAmount > SOCKET_HIGH_WATERMARK;
    if (backedUp) {
      if (this.degradeTimer === null && !this.congested) {
        this.degradeTimer = this.clock.setTimeout(() => {
          this.degradeTimer = null;
          this.congested = true;
          this.refresh();
        }, SOCKET_DEGRADE_MS);
      }
    } else {
      if (this.degradeTimer !== null) this.clock.clearTimeout(this.degradeTimer);
      this.degradeTimer = null;
      if (this.congested) {
        this.congested = false;
        this.refresh();
      }
    }
    if ((waiting || this.socket.bufferedAmount > SOCKET_LOW_WATERMARK) && this.drainTimer === null) {
      this.drainTimer = this.clock.setTimeout(() => {
        this.drainTimer = null;
        this.pump();
      }, DRAIN_POLL_MS);
    }
  }

  private refresh(): void {
    if (this.current === 'closed' || !this.everOpen) return;
    if (this.congested) this.setState('degraded', 'congested');
    else this.setState('open');
  }

  /** Stops listening to the socket and every timer; the socket itself is closed by the caller. */
  private release(): void {
    this.lifetime.abort();
    for (const timer of [this.connectTimer, this.drainTimer, this.degradeTimer]) {
      if (timer !== null) this.clock.clearTimeout(timer);
    }
    this.connectTimer = this.drainTimer = this.degradeTimer = null;
    this.queue = [];
    this.head = 0;
    this.queuedBytes = 0;
  }

  private finish(reason: string): void {
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

/** Connects to the LAN relay at `url` with the session's `token`. The transport starts 'connecting'. */
export function openSocketTransport(url: string, token: string, options: SocketTransportOptions = {}): CollabTransport {
  return new SocketTransport(url, token, options);
}
