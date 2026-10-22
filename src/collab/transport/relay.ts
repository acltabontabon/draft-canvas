/**
 * The rendezvous relay's socket: how an owner and someone knocking exchange a handful of sealed
 * messages before their browsers connect to each other directly.
 *
 * The relay (relay.draftcanvas.dev, or `node scripts/dev-relay.mjs` in development) is a pipe and nothing more. Everything sent through it is
 * already encrypted (`collab/rendezvous.ts`) with a key the relay never sees — it lives in the
 * session link's fragment — so it learns a random room id, that some sockets talked, and when. It
 * routes by role: a guest's messages go to the room's one host, the host addresses each guest by a
 * tag the relay assigned. Once the peers are connected, nothing more goes through it.
 */

export type RelayRole = 'host' | 'guest';

export type RelayState = 'connecting' | 'open' | 'closed';

export type RelayEvent =
  | { kind: 'message'; from: string; data: string }
  /** Host only: a guest's socket closed. */
  | { kind: 'left'; from: string }
  /** Guest only: whether the room's host is connected. */
  | { kind: 'host'; present: boolean }
  /** Host only: the relay accepted this socket as the room's host. */
  | { kind: 'ready' };

export interface RelayChannel {
  readonly state: RelayState;
  /** `to` is `'host'` from a guest, or a guest's tag from the host. False when not open. */
  send(to: string, data: string): boolean;
  onEvent(listener: (event: RelayEvent) => void): () => void;
  onState(listener: (state: RelayState, reason?: string) => void): () => void;
  close(): void;
}

/** The relay refuses anything longer; sealed rendezvous messages are far smaller. */
export const MAX_RELAY_DATA = 16_384;

/** The subprotocol the relay speaks. A host's request adds `host.<secret>` — see `openRelay`. */
export const RELAY_PROTOCOL = 'draft-canvas.relay.v1';

/** How long a connection may take to open before the relay counts as unreachable. */
export const RELAY_CONNECT_TIMEOUT_MS = 8_000;

const ROOM = /^[A-Za-z0-9_-]{22}$/;

/**
 * Opens one socket into `room`. The host presents `hostSecret` — never part of the session link — and
 * the relay lets only the socket that first presented it host the room, so someone holding the link
 * can't take the owner's place while the owner's connection is down.
 */
export function openRelay(base: string, room: string, role: RelayRole, hostSecret?: string): RelayChannel {
  if (!ROOM.test(room)) throw new Error('Not a room id.');
  if (role === 'host' && !(hostSecret && /^[A-Za-z0-9_-]{43}$/.test(hostSecret))) throw new Error('A host needs its secret.');
  const url = new URL(`r/${room}`, base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('role', role);
  const events = new Set<(event: RelayEvent) => void>();
  const states = new Set<(state: RelayState, reason?: string) => void>();
  let state: RelayState = 'connecting';
  // The secret travels in the handshake's subprotocol list, so it never appears in a URL or a log of one.
  const socket = new WebSocket(url.toString(), role === 'host' ? [RELAY_PROTOCOL, `host.${hostSecret}`] : [RELAY_PROTOCOL]);

  const setState = (next: RelayState, reason?: string) => {
    if (state === next) return;
    state = next;
    for (const listener of [...states]) listener(next, reason);
  };
  const timer = setTimeout(() => {
    if (state === 'connecting') {
      socket.close();
      setState('closed', 'timeout');
    }
  }, RELAY_CONNECT_TIMEOUT_MS);

  socket.addEventListener('open', () => {
    clearTimeout(timer);
    setState('open');
  });
  socket.addEventListener('close', (event) => {
    clearTimeout(timer);
    setState('closed', event.reason || String(event.code));
  });
  socket.addEventListener('error', () => {
    // A `close` always follows; the reason travels with it.
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data.length > MAX_RELAY_DATA + 1024) return;
    const relayed = readRelayFrame(event.data);
    if (relayed) for (const listener of [...events]) listener(relayed);
  });

  return {
    get state() {
      return state;
    },
    send(to, data) {
      if (state !== 'open' || data.length > MAX_RELAY_DATA) return false;
      socket.send(JSON.stringify({ to, data }));
      return true;
    },
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    onState(listener) {
      states.add(listener);
      return () => states.delete(listener);
    },
    close() {
      clearTimeout(timer);
      events.clear();
      if (state !== 'closed') socket.close(1000);
      setState('closed', 'closed');
      states.clear();
    },
  };
}

/** One frame from the relay, read strictly; anything else is dropped. */
export function readRelayFrame(text: string): RelayEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  const from = typeof frame.from === 'string' && frame.from.length <= 32 ? frame.from : null;
  if (frame.event === 'left' && from) return { kind: 'left', from };
  if (frame.event === 'host' && typeof frame.present === 'boolean') return { kind: 'host', present: frame.present };
  if (frame.event === 'ready') return { kind: 'ready' };
  if (from && typeof frame.data === 'string' && frame.data.length <= MAX_RELAY_DATA) return { kind: 'message', from, data: frame.data };
  return null;
}
