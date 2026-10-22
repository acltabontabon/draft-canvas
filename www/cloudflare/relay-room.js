// The live-collaboration relay's rules, with no platform in them: which requests may connect, who
// may join a room, and what happens to each frame. `relay.js` (the Cloudflare Worker and its Durable
// Object) and `scripts/dev-relay.mjs` (the local and e2e relay) both run exactly this, so the relay
// a developer tests against is the relay that ships.
//
// The relay is a pipe for a handful of small messages — a knock, then a WebRTC offer and answer —
// that the two browsers encrypt with a key the relay never sees (it lives in the invite link's
// fragment). So nothing here reads, keeps or logs `data`: it is length-checked and passed along.
//
// One thing a room does remember: who its owner is. The first host socket presents a secret of its
// own (never in the session link) and the room keeps that secret's SHA-256, for the room's lifetime at
// most; any later host socket must present the same secret. Without it, anyone holding the link could
// take the owner's place on the relay while the owner's connection was down — they still couldn't
// pose as the owner (knockers check the owner's signature), but they could keep everyone waiting.
//
// A room's sockets are given to every function here as `peers`, each an object with:
//   read()             the socket's state (see `openState`)
//   write(state)       replaces it — the Durable Object keeps it in the socket's attachment, so it
//                      survives hibernation; the dev relay keeps it in memory
//   send(text)         sends a text frame; must not throw
//   close(code, why)   starts the closing handshake; must not throw
// `peers` is every socket the platform still holds open for the room, the subject one included.

export const LIMITS = Object.freeze({
  /** Longest `data` string a client may send. */
  maxData: 16384,
  /** Longest whole text frame (17 KB of characters); past it the socket is closed with 1009. */
  maxFrame: 17 * 1024,
  /** Guest sockets per room; the next one is closed with 4002. */
  maxGuests: 32,
  /** Token bucket: this many messages… */
  rateMessages: 30,
  /** …per this many milliseconds, refilled continuously. */
  rateWindowMs: 10_000,
  /** Malformed frames tolerated per socket before it is closed with 1008. */
  maxBadFrames: 20,
  /** A room that carries no message for this long is closed. */
  idleMs: 15 * 60_000,
  /** No room lives longer than this, busy or not. */
  lifetimeMs: 12 * 60 * 60_000,
  /** New sockets one address may open per minute, across every room — so the relay can't be farmed. */
  connectsPerMinute: 60,
});

/** The subprotocol every socket asks for; a host's request also carries `host.<secret>`. */
export const PROTOCOL = 'draft-canvas.relay.v1';
/** A host's secret: 256 random bits, base64url without padding. */
const HOST_SECRET = /^host\.([A-Za-z0-9_-]{43})$/;

export const CLOSE = Object.freeze({
  hostTaken: Object.freeze({ code: 4001, reason: 'host-taken' }),
  notOwner: Object.freeze({ code: 4003, reason: 'not-owner' }),
  roomFull: Object.freeze({ code: 4002, reason: 'room-full' }),
  binary: Object.freeze({ code: 1003, reason: 'binary' }),
  tooLarge: Object.freeze({ code: 1009, reason: 'too-large' }),
  rate: Object.freeze({ code: 1008, reason: 'rate' }),
  congested: Object.freeze({ code: 1008, reason: 'congested' }),
  invalid: Object.freeze({ code: 1008, reason: 'invalid' }),
  idle: Object.freeze({ code: 1001, reason: 'idle' }),
  expired: Object.freeze({ code: 1001, reason: 'expired' }),
});

/** Where the app is served from: the web editor, and the desktop app's webview on each platform. */
export const DEFAULT_ORIGINS = Object.freeze([
  'https://app.draftcanvas.dev',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

/** 128 random bits, base64url without padding. */
const ROOM = /^[A-Za-z0-9_-]{22}$/;
const ROOM_PATH = /^\/r\/([^/]*)$/;
export const GUEST_TAG = /^g_[0-9a-z]{12}$/;
const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/** `ALLOWED_ORIGINS` (comma-separated) as a list; unset or blank means the defaults. */
export function parseOrigins(value) {
  const listed = typeof value === 'string' ? value.split(',').map((origin) => origin.trim()).filter(Boolean) : [];
  return listed.length > 0 ? listed : [...DEFAULT_ORIGINS];
}

/**
 * Whether a page at `origin` may use the relay. `loopback` also admits any `http://localhost:*` and
 * `http://127.0.0.1:*` — the dev relay's, for `npm run dev`, `tauri dev` and the e2e suite.
 */
export function originAllowed(origin, origins, { loopback = false } = {}) {
  if (typeof origin !== 'string' || origin === '') return false;
  return origins.includes(origin) || (loopback && LOOPBACK.test(origin));
}

const TEXT = 'text/plain; charset=utf-8';

function reject(status, body, headers = {}) {
  return { kind: 'reject', status, body, headers: { 'content-type': TEXT, ...headers } };
}

/**
 * What to do with an HTTP request, before any socket exists. `url` is the request target (a full
 * URL or a path with its query); `upgrade` is the `Upgrade` header, and `protocols` the
 * `Sec-WebSocket-Protocol` header, if any.
 *
 * Returns `{ kind: 'health' }`, `{ kind: 'connect', room, role, secret }` (`secret` is the host's,
 * `null` for a guest), or `{ kind: 'reject', status, body, headers }`.
 */
export function checkRequest({ method, url, upgrade, origin, protocols }, { origins, loopback = false }) {
  let parsed;
  try {
    parsed = new URL(url, 'http://relay.invalid');
  } catch {
    return reject(400, 'bad request\n');
  }
  if (parsed.pathname === '/health' && method === 'GET' && !parsed.search) {
    return { kind: 'health' };
  }
  const match = ROOM_PATH.exec(parsed.pathname);
  const role = parsed.searchParams.get('role');
  if (!match || !ROOM.test(match[1]) || (role !== 'host' && role !== 'guest')) {
    return reject(400, 'bad request\n');
  }
  if (method !== 'GET' || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
    return reject(426, 'websocket upgrade required\n', { upgrade: 'websocket' });
  }
  if (!originAllowed(origin, origins, { loopback })) {
    return reject(403, 'forbidden\n');
  }
  const offered = typeof protocols === 'string' ? protocols.split(',').map((item) => item.trim()).filter(Boolean) : [];
  const secrets = offered.map((item) => HOST_SECRET.exec(item)?.[1]).filter(Boolean);
  // A host names exactly one secret; a guest names none. Anything else is not a client of ours.
  if (!offered.includes(PROTOCOL) || offered.length !== (role === 'host' ? 2 : 1) || secrets.length !== (role === 'host' ? 1 : 0)) {
    return reject(401, 'unauthorized\n');
  }
  return { kind: 'connect', room: match[1], role, secret: role === 'host' ? secrets[0] : null };
}

/**
 * Whether `address` may open another socket now: at most `LIMITS.connectsPerMinute` a minute, across
 * every room. `seen` maps addresses to their recent connection times; old entries are dropped as they
 * pass. Cloudflare enforces the same budget with a rate-limiting binding; the dev relay uses this.
 */
export function connectionAllowed(seen, address, now) {
  const since = now - 60_000;
  const recent = (seen.get(address) ?? []).filter((at) => at > since);
  if (seen.size > 10_000) for (const [key, times] of seen) if (!times.some((at) => at > since)) seen.delete(key);
  if (recent.length >= LIMITS.connectsPerMinute) {
    seen.set(address, recent);
    return false;
  }
  recent.push(now);
  seen.set(address, recent);
  return true;
}

/** The SHA-256 of a host's secret, as hex: all a room keeps of it. */
export async function secretDigest(secret) {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a host socket presenting `digest` is the room's owner. `claim` is what the room remembers —
 * `{ digest, until }`, or `null` — and the result says whether to remember a new one.
 * Returns `{ verdict: 'owner' }`, `{ verdict: 'claim', claim }` (first host, or the old claim expired),
 * or `{ verdict: 'not-owner' }`.
 */
export function checkOwner(claim, digest, now) {
  if (!claim || typeof claim.digest !== 'string' || !(now < claim.until)) {
    return { verdict: 'claim', claim: { digest, until: now + LIMITS.lifetimeMs } };
  }
  return sameText(claim.digest, digest) ? { verdict: 'owner' } : { verdict: 'not-owner' };
}

/** Compares two strings in time that doesn't depend on where they first differ. */
function sameText(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** `g_` and 12 random base36 characters, drawn without modulo bias. */
export function guestTag(random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  let tag = 'g_';
  while (tag.length < 14) {
    for (const byte of random(new Uint8Array(16))) {
      // 252 = 7 × 36: dropping the four values above it keeps every character equally likely.
      if (byte < 252 && tag.length < 14) tag += BASE36[byte % 36];
    }
  }
  return tag;
}

/** The sockets of a room the relay still counts: open, and not already being closed by it. */
export function live(peers) {
  return peers.filter((peer) => !peer.read().gone);
}

function hostOf(peers) {
  return live(peers).find((peer) => peer.read().role === 'host') ?? null;
}

function guestsOf(peers) {
  return live(peers).filter((peer) => peer.read().role === 'guest');
}

/** A guest tag no socket in the room has, so the host can always tell its guests apart. */
export function uniqueGuestTag(peers, random) {
  const taken = new Set(peers.map((peer) => peer.read().tag));
  for (;;) {
    const tag = guestTag(random);
    if (!taken.has(tag)) return tag;
  }
}

/**
 * Whether a new socket in `role` may join the room as it stands: `null`, or the close it gets.
 * Call it before the new socket is counted among `peers`.
 */
export function admission(peers, role) {
  if (role === 'host') return hostOf(peers) ? CLOSE.hostTaken : null;
  return guestsOf(peers).length >= LIMITS.maxGuests ? CLOSE.roomFull : null;
}

/**
 * A new socket's state. The room's birth time travels with every socket (there is no other place to
 * keep it through hibernation), so a newcomer inherits the earliest one still in the room.
 */
export function openState(peers, role, tag, now) {
  const others = live(peers);
  const born = others.length > 0 ? Math.min(...others.map((peer) => peer.read().born)) : now;
  return {
    role,
    tag: role === 'guest' ? tag : null,
    tokens: LIMITS.rateMessages,
    at: now,
    bad: 0,
    born,
    last: now,
    gone: false,
  };
}

export const events = Object.freeze({
  ready: () => JSON.stringify({ event: 'ready' }),
  host: (present) => JSON.stringify({ event: 'host', present }),
  left: (tag) => JSON.stringify({ event: 'left', from: tag }),
  message: (from, data) => JSON.stringify({ from, data }),
});

/** Tells the room a socket has joined. `peer` has its state written and is among `peers`. */
export function opened(peers, peer) {
  const state = peer.read();
  if (state.role === 'host') {
    peer.send(events.ready());
    for (const guest of guestsOf(peers)) guest.send(events.host(true));
  } else {
    peer.send(events.host(hostOf(peers) !== null));
  }
}

function announceDeparture(peers, state) {
  // The room's last activity lives on whichever socket saw it. Hand it on before this one goes, or a
  // busy room could look idle the moment its most recent speaker leaves.
  const rest = live(peers);
  if (rest.length > 0 && state.last > Math.max(...rest.map((peer) => peer.read().last))) {
    rest[0].write({ ...rest[0].read(), last: state.last });
  }
  if (state.role === 'host') {
    for (const guest of guestsOf(peers)) guest.send(events.host(false));
  } else {
    hostOf(peers)?.send(events.left(state.tag));
  }
}

/** Closes a socket from the relay's side and tells the room at once, without waiting for the client. */
export function closePeer(peers, peer, close) {
  const state = peer.read();
  if (state.gone) return;
  peer.write({ ...state, gone: true });
  peer.close(close.code, close.reason);
  announceDeparture(peers, state);
}

/** A socket closed from the client's side or failed. Safe to call for a socket already closed. */
export function departed(peers, peer) {
  const state = peer.read();
  if (state.gone) return;
  peer.write({ ...state, gone: true });
  announceDeparture(peers, state);
}

/** `{ to, data }` with exactly those two string fields, or `null`. */
function readFrame(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !('to' in value) || !('data' in value)) return null;
  const { to, data } = value;
  if (typeof to !== 'string' || typeof data !== 'string' || data.length > LIMITS.maxData) return null;
  return { to, data };
}

/**
 * One frame from `peer`: `text` is the frame's text, or `null` for a binary frame. Applies every
 * limit in order — type, size, rate, shape — then delivers it, or drops it, or closes the socket.
 */
export function received(peers, peer, text, now) {
  let state = peer.read();
  if (state.gone) return;
  if (typeof text !== 'string') return closePeer(peers, peer, CLOSE.binary);
  if (text.length > LIMITS.maxFrame) return closePeer(peers, peer, CLOSE.tooLarge);

  const refill = ((now - state.at) * LIMITS.rateMessages) / LIMITS.rateWindowMs;
  const tokens = Math.min(LIMITS.rateMessages, state.tokens + Math.max(0, refill));
  if (tokens < 1) return closePeer(peers, peer, CLOSE.rate);
  state = { ...state, tokens: tokens - 1, at: now };

  const frame = readFrame(text);
  const addressed = frame !== null && (state.role === 'guest' ? frame.to === 'host' : GUEST_TAG.test(frame.to));
  if (!addressed) {
    state = { ...state, bad: state.bad + 1 };
    peer.write(state);
    if (state.bad > LIMITS.maxBadFrames) closePeer(peers, peer, CLOSE.invalid);
    return;
  }
  peer.write({ ...state, last: now });

  // A frame for someone not here is dropped quietly: a guest may knock before the owner arrives, and
  // a guest may leave while the owner's answer is on its way. Neither is the sender's fault.
  if (state.role === 'guest') {
    hostOf(peers)?.send(events.message(state.tag, frame.data));
  } else {
    guestsOf(peers).find((guest) => guest.read().tag === frame.to)?.send(events.message('host', frame.data));
  }
}

/** When the room next needs looking at: whichever comes first of going idle and expiring. */
export function deadline(peers) {
  const open = live(peers);
  if (open.length === 0) return null;
  const last = Math.max(...open.map((peer) => peer.read().last));
  const born = Math.min(...open.map((peer) => peer.read().born));
  return Math.min(last + LIMITS.idleMs, born + LIMITS.lifetimeMs);
}

/**
 * Closes the whole room if it has gone idle or reached its lifetime. Returns when to look again,
 * or `null` when the room is empty or has just been closed.
 */
export function sweep(peers, now) {
  const open = live(peers);
  if (open.length === 0) return null;
  const born = Math.min(...open.map((peer) => peer.read().born));
  const last = Math.max(...open.map((peer) => peer.read().last));
  const close = now >= born + LIMITS.lifetimeMs ? CLOSE.expired : now >= last + LIMITS.idleMs ? CLOSE.idle : null;
  if (!close) return deadline(open);
  // Everyone goes at once, so nobody is told about anybody else leaving.
  for (const peer of open) peer.write({ ...peer.read(), gone: true });
  for (const peer of open) peer.close(close.code, close.reason);
  return null;
}
