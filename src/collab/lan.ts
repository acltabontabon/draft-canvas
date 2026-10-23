/**
 * Collaboration on the local network, through the desktop app's relay — the one door into
 * `collab/transport/` for it, as `connect.ts` is for WebRTC (nothing outside `collab/` may import
 * the transports: `tests/privacy.test.ts`).
 *
 * The owner's desktop app serves this app at `http://<address>:<port>/` and relays text between the
 * page and guests on `/collab`. A link carries the session's token in its fragment
 * (`#join=lan.<token>`), which never reaches a server log or a `Referer`. Anyone holding the link
 * can join while sharing is on; turning it off, or on again, makes every earlier link useless. The
 * traffic itself is unencrypted on the local network (plain HTTP and sockets) — the owner is told so.
 */
import { LanHostRelay, type LanRelayEvent, type LanRelayLink } from './transport/lanHost';
import { lanSocketUrl, openSocketTransport, type SocketTransportOptions } from './transport/socket';
import type { CollabTransport } from './transport/types';

export type { CollabTransport, TransportState } from './transport/types';
export type { LanRelayEvent } from './transport/lanHost';

/** The `#join=` payload prefix of a LAN link; WebRTC invites start `1.`. */
export const LAN_PAYLOAD_PREFIX = 'lan.';
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** The desktop app's relay, as `src/desktop/collabLan.ts` adapts `DesktopApi` to it. */
export interface LanRelay extends LanRelayLink {
  start(token: string): Promise<{ port: number; addresses: string[] }>;
  /** With `token`, stops the server only while it runs that session. */
  stop(token?: string): Promise<void>;
  /** Every `collab-lan-*` event the shell sends, in order. */
  subscribe(listener: (event: LanRelayEvent) => void): () => void;
}

/** A new 128-bit session secret: 32 lowercase hex characters, the form the relay requires. */
export function newLanToken(): string {
  // `getRandomValues` works on an insecure page too, unlike `randomUUID` and `crypto.subtle`.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isLanToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** The token a `#join=` payload carries, when it is a LAN link's; `null` for anything else. */
export function lanTokenFromPayload(payload: string): string | null {
  if (!payload.startsWith(LAN_PAYLOAD_PREFIX)) return null;
  const token = payload.slice(LAN_PAYLOAD_PREFIX.length).toLowerCase();
  return isLanToken(token) ? token : null;
}

/** An address as it goes in a URL's host: IPv6 in brackets (its zone, if any, escaped). */
export function urlHost(address: string): string {
  if (!address.includes(':')) return address;
  const bare = address.replace(/^\[|\]$/g, '');
  return `[${bare.replace(/%(?!25)/, '%25')}]`;
}

/**
 * The links to hand out, one per address, in the shell's order (best first). An address that does
 * not make a valid URL is left out rather than handed to someone as a broken link.
 */
export function lanLinks(port: number, addresses: readonly string[], token: string): string[] {
  if (!isLanToken(token)) throw new Error('A LAN session token is 32 lowercase hex characters.');
  const links: string[] = [];
  for (const address of addresses) {
    try {
      const url = new URL(`http://${urlHost(address.trim())}:${port}/`);
      url.hash = `join=${LAN_PAYLOAD_PREFIX}${token}`;
      const link = url.toString();
      if (!links.includes(link)) links.push(link);
    } catch {
      /* Not an address a browser could open. */
    }
  }
  return links;
}

/** What a link shows as: its address and port, without the secret. */
export function linkLabel(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

export interface LanSharingOptions {
  /** Each guest's connection, open and past the relay's token check: attach it to the host session. */
  onTransport(transport: CollabTransport): void;
  /** The relay stopped without `stop()` being called: the window closed, the page reloaded. */
  onStopped?(reason: string): void;
  /** The session's token. A fresh one by default, so turning sharing on again revokes old links. */
  token?: string;
}

export interface LanSharing {
  readonly token: string;
  readonly port: number;
  /** One link per address, best first. Empty when this computer has no usable network address. */
  readonly links: readonly string[];
  /** Guests connected right now. */
  readonly connections: number;
  /** Closes every guest's connection and stops listening. Safe to call more than once. */
  stop(): Promise<void>;
}

/**
 * Starts the relay with a session token and routes its guests to `onTransport`. Rejects with the
 * shell's error when it can't listen. Events that arrive between the start and its answer (a guest
 * who already had the link) are routed too: the subscription comes first.
 */
export async function startLanSharing(relay: LanRelay, options: LanSharingOptions): Promise<LanSharing> {
  const token = options.token ?? newLanToken();
  if (!isLanToken(token)) throw new Error('A LAN session token is 32 lowercase hex characters.');
  let stopped = false;
  const host = new LanHostRelay(relay, {
    connection: (transport) => options.onTransport(transport),
    stopped: (reason) => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      options.onStopped?.(reason);
    },
  });
  const unsubscribe = relay.subscribe((event) => {
    if (stopped) return;
    // A stop finishing late for the session before this one (sharing turned off and straight back
    // on) is not this one's: it would end it, and its own stop would then stop the server just started.
    if (event.type === 'collab-lan-stopped' && event.token !== undefined && event.token !== token) return;
    host.handle(event);
  });
  let started: { port: number; addresses: string[] };
  try {
    started = await relay.start(token);
  } catch (error) {
    stopped = true;
    unsubscribe();
    host.closeAll('stopped');
    throw error;
  }
  const links = lanLinks(started.port, started.addresses, token);
  return {
    token,
    port: started.port,
    links,
    get connections() {
      return host.size;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      host.closeAll('stopped');
      // Only this session's server: a stop that answers late (sharing was turned off and on again)
      // must not end the session that replaced it.
      await relay.stop(token);
    },
  };
}

/* ----------------------------------------------------------------- guest -- */

/**
 * A guest's connection to the relay that served this page. It starts 'connecting'; hand it to
 * `joinSession` at once — the hello waits for it to open.
 */
export function openLanGuest(token: string, options: SocketTransportOptions & { location?: { protocol: string; host: string } } = {}): CollabTransport {
  if (!isLanToken(token)) throw new Error('A LAN session token is 32 lowercase hex characters.');
  const { location = globalThis.location, ...socket } = options;
  return openSocketTransport(lanSocketUrl(location), token, socket);
}

export const LAN_RETRY_BASE_MS = 500;
export const LAN_RETRY_CAP_MS = 15_000;
/** How long after a drop the guest keeps trying: long enough for a laptop lid or a Wi-Fi hiccup. */
export const LAN_GIVE_UP_MS = 2 * 60_000;
/** A link that never connected at all is most likely stale: a few quick tries, then say so. */
export const LAN_FIRST_CONNECT_ATTEMPTS = 3;

/**
 * The wait before retry number `attempt` (0-based): doubling from `LAN_RETRY_BASE_MS` up to
 * `LAN_RETRY_CAP_MS`, with "equal jitter" — between half and all of that — so guests dropped together
 * don't all knock at once, and none retries in a tight loop.
 */
export function lanRetryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(LAN_RETRY_CAP_MS, LAN_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
  return Math.round(ceiling / 2 + (ceiling / 2) * Math.min(1, Math.max(0, random())));
}

/**
 * Why a guest stopped trying: `stopped` — the owner turned sharing off or restarted it (the link no
 * longer works); `unreachable` — the link never connected, or the owner has been gone two minutes.
 */
export type LanGiveUpReason = 'stopped' | 'unreachable';

/** Close reasons after which another try can't work: the relay is gone, or the token changed. */
const FINAL_REASONS = new Set(['token-changed', 'server-stopped', 'stopped', 'window-closed', 'reload', 'protocol']);

export interface LanReconnectOptions {
  /** Hands each new connection to the session: `collabBridge.reconnectSession`. */
  reconnect(transport: CollabTransport): void;
  /** Whether the session still wants a connection (`guestSession() !== null`). Checked before every try. */
  wanted(): boolean;
  /** Called once, when trying stops for good while the session still wanted a connection. */
  gaveUp(reason: LanGiveUpReason): void;
  /** Each scheduled try, for a "Reconnecting…" line. */
  retrying?(attempt: number, delayMs: number): void;
  /** Test seams. */
  open?: (token: string) => CollabTransport;
  clock?: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
  random?: () => number;
}

export interface LanReconnect {
  /** For `joinSession`'s `lost`: the session noticed the connection drop. Idempotent. */
  lost(): void;
  /** Stops trying (leaving the session, or the dialog closing). */
  stop(): void;
}

const realClock = {
  setTimeout: (run: () => void, ms: number): unknown => globalThis.setTimeout(run, ms),
  clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Keeps a LAN guest connected: when `first` (or any later connection) closes, opens a new one after
 * `lanRetryDelay` and hands it to `reconnect`, until one opens — then the schedule starts over — or
 * `LAN_GIVE_UP_MS` has passed since the drop. The guest's session resumes on the new connection by
 * itself (its hello carries its resume key), and edits made meanwhile are sent then.
 *
 *     const transport = openLanGuest(token);
 *     const keeper = keepLanGuestConnected(token, transport, { reconnect: reconnectSession, wanted, gaveUp });
 *     joinSession(transport, { name, token, open, lost: keeper.lost });
 */
export function keepLanGuestConnected(token: string, first: CollabTransport, options: LanReconnectOptions): LanReconnect {
  const clock = options.clock ?? realClock;
  const open = options.open ?? ((secret: string) => openLanGuest(secret));
  let current = first;
  let everOpened = first.state === 'open' || first.state === 'degraded';
  let attempt = 0;
  let droppedAt: number | null = null;
  let timer: unknown = null;
  let done = false;
  let release: () => void = () => {};

  const finish = (reason: LanGiveUpReason | null) => {
    if (done) return;
    done = true;
    release();
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (reason !== null && options.wanted()) options.gaveUp(reason);
  };

  const dropped = (reason: string | undefined) => {
    if (done || timer !== null) return;
    if (!options.wanted()) return finish(null);
    if (reason !== undefined && FINAL_REASONS.has(reason)) return finish('stopped');
    const now = clock.now();
    droppedAt ??= now;
    if (!everOpened && attempt >= LAN_FIRST_CONNECT_ATTEMPTS) return finish('unreachable');
    const delay = lanRetryDelay(attempt, options.random);
    if (now + delay - droppedAt > LAN_GIVE_UP_MS) return finish('unreachable');
    attempt += 1;
    options.retrying?.(attempt, delay);
    timer = clock.setTimeout(() => {
      timer = null;
      if (done) return;
      if (!options.wanted()) return finish(null);
      let next: CollabTransport;
      try {
        next = open(token);
      } catch {
        return finish('unreachable');
      }
      watch(next);
      options.reconnect(next);
    }, delay);
  };

  const watch = (transport: CollabTransport) => {
    release();
    current = transport;
    if (transport.state === 'closed') {
      release = () => {};
      dropped(undefined);
      return;
    }
    release = transport.onState((state, reason) => {
      if (transport !== current || done) return;
      if (state === 'open') {
        everOpened = true;
        attempt = 0;
        droppedAt = null;
      } else if (state === 'closed') {
        dropped(reason);
      }
    });
  };

  watch(first);
  return {
    lost() {
      if (!done && current.state === 'closed') dropped(undefined);
    },
    stop() {
      finish(null);
    },
  };
}
