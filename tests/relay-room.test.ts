import { describe, expect, it } from 'vitest';
import {
  CLOSE,
  DEFAULT_ORIGINS,
  GUEST_TAG,
  LIMITS,
  PROTOCOL,
  admission,
  checkOwner,
  renewClaim,
  checkRequest,
  clientKey,
  closePeer,
  connectionAllowed,
  deadline,
  departed,
  guestTag,
  live,
  openState,
  opened,
  originAllowed,
  parseOrigins,
  received,
  sweep,
  uniqueGuestTag,
  type Peer,
  type SocketState,
} from '../www/cloudflare/relay-room.js';

/**
 * The collaboration relay's rules, as both relays run them (www/cloudflare/relay.js on Cloudflare,
 * scripts/dev-relay.mjs locally). The wire itself is covered by tests/dev-relay.test.ts.
 */

interface FakePeer extends Peer {
  sent: unknown[];
  closed: { code: number; reason: string } | null;
}

const ROOM = 'AbCdEfGhIjKlMnOpQrStU_';

class FakeRoom {
  peers: FakePeer[] = [];

  join(role: 'host' | 'guest', now = 0, client: string | null = null): FakePeer | { code: number; reason: string } {
    const open = this.open();
    const refused = admission(open, role, client);
    if (refused) return refused;
    let state: SocketState = openState(open, role, role === 'guest' ? uniqueGuestTag(open) : null, now, client);
    const peer: FakePeer = {
      sent: [],
      closed: null,
      read: () => state,
      write: (next) => {
        state = next;
      },
      send: (text) => peer.sent.push(JSON.parse(text)),
      close: (code, reason) => {
        peer.closed = { code, reason };
      },
    };
    this.peers.push(peer);
    opened(this.open(), peer);
    return peer;
  }

  /** What a platform lists: sockets it has not seen close. */
  open(): FakePeer[] {
    return this.peers.filter((peer) => peer.closed === null);
  }

  host(now = 0): FakePeer {
    const peer = this.join('host', now);
    if (!('read' in peer)) throw new Error(`host refused: ${peer.reason}`);
    return peer;
  }

  guest(now = 0): FakePeer {
    const peer = this.join('guest', now);
    if (!('read' in peer)) throw new Error(`guest refused: ${peer.reason}`);
    return peer;
  }

  send(peer: FakePeer, frame: unknown, now = 0) {
    received(this.open(), peer, typeof frame === 'string' || frame === null ? frame : JSON.stringify(frame), now);
  }

  /** The client closes its socket. */
  leave(peer: FakePeer) {
    peer.closed = { code: 1000, reason: '' };
    departed(this.open(), peer);
  }
}

const tagOf = (peer: Peer) => peer.read().tag as string;
const SECRET = 'S'.repeat(43);
const request = (overrides: Partial<Parameters<typeof checkRequest>[0]> = {}) =>
  checkRequest(
    {
      method: 'GET',
      url: `/r/${ROOM}?role=host`,
      upgrade: 'websocket',
      origin: 'https://app.draftcanvas.dev',
      protocols: `${PROTOCOL}, host.${SECRET}`,
      ...overrides,
    },
    { origins: [...DEFAULT_ORIGINS] },
  );

describe('relay requests', () => {
  it('serves its health check and nothing else', () => {
    expect(request({ url: '/health', upgrade: null })).toEqual({ kind: 'health' });
    expect(request({ url: '/', upgrade: null })).toMatchObject({ kind: 'reject', status: 400 });
    expect(request({ url: '/health', method: 'POST' })).toMatchObject({ kind: 'reject', status: 400 });
    expect(request({ url: '/favicon.ico' })).toMatchObject({ kind: 'reject', status: 400 });
  });

  it('accepts a 22-character base64url room and a known role', () => {
    expect(request()).toEqual({ kind: 'connect', room: ROOM, role: 'host', secret: SECRET });
    expect(request({ url: `https://relay.draftcanvas.dev/r/${ROOM}?role=guest`, protocols: PROTOCOL })).toEqual({ kind: 'connect', room: ROOM, role: 'guest', secret: null });
  });

  it('wants the relay’s subprotocol from everyone, and exactly one secret from a host', () => {
    expect(request({ protocols: null })).toMatchObject({ kind: 'reject', status: 401 });
    expect(request({ protocols: PROTOCOL })).toMatchObject({ kind: 'reject', status: 401 });
    expect(request({ protocols: `host.${SECRET}` })).toMatchObject({ kind: 'reject', status: 401 });
    expect(request({ protocols: `${PROTOCOL}, host.${SECRET}, host.${SECRET}` })).toMatchObject({ kind: 'reject', status: 401 });
    expect(request({ protocols: `${PROTOCOL}, host.short` })).toMatchObject({ kind: 'reject', status: 401 });
    // A guest presenting a host secret is not a guest of ours.
    expect(request({ url: `/r/${ROOM}?role=guest`, protocols: `${PROTOCOL}, host.${SECRET}` })).toMatchObject({ kind: 'reject', status: 401 });
  });
});

describe('connections per client', () => {
  it('counts an IPv6 client by its /64, which it can take a fresh address from each time', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('[fe80::1%en0]')).toBe('fe80:0:0:0::/64');
    expect(clientKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(clientKey('192.0.2.7')).toBe('192.0.2.7');
    expect(clientKey(null)).toBe('unknown');
  });

  it('holds a whole /64 to one client’s budget', () => {
    const seen = new Map<string, number[]>();
    for (let i = 0; i < LIMITS.connectsPerMinute; i += 1) expect(connectionAllowed(seen, `2001:db8:1:2::${i.toString(16)}`, 1000)).toBe(true);
    expect(connectionAllowed(seen, '2001:db8:1:2:ffff::9', 1000)).toBe(false);
    expect(connectionAllowed(seen, '2001:db8:1:3::1', 1000)).toBe(true);
  });
});

describe('who owns a room', () => {
  it('is whoever claimed it first, until a lifetime after they were last there — nobody else may host it', () => {
    const first = checkOwner(null, 'aa', 1000);
    expect(first).toEqual({ verdict: 'claim', claim: { digest: 'aa', until: 1000 + LIMITS.lifetimeMs } });
    const claim = first.verdict === 'claim' ? first.claim : null;
    expect(checkOwner(claim, 'aa', 2000)).toEqual({ verdict: 'owner', claim: { digest: 'aa', until: 2000 + LIMITS.lifetimeMs } });
    expect(checkOwner(claim, 'bb', 2000)).toEqual({ verdict: 'not-owner' });
    expect(checkOwner(claim, 'a', 2000)).toEqual({ verdict: 'not-owner' });
    // Once a lifetime has passed with the owner gone, the claim is gone and the room starts afresh.
    expect(checkOwner(claim, 'bb', 1000 + LIMITS.lifetimeMs)).toMatchObject({ verdict: 'claim' });
  });

  it('outlasts a session longer than one lifetime: the owner’s every connection and departure renews it', () => {
    const opened = checkOwner(null, 'aa', 0);
    if (opened.verdict === 'not-owner') throw new Error('the first host claims the room');
    let claim = opened.claim;
    // The owner's socket is swept away near the end of the first lifetime and reconnects a second later;
    // someone holding the link tries to host in between.
    claim = renewClaim(claim, LIMITS.lifetimeMs - 1)!;
    expect(checkOwner(claim, 'bb', LIMITS.lifetimeMs + 500)).toEqual({ verdict: 'not-owner' });
    expect(checkOwner(claim, 'aa', LIMITS.lifetimeMs + 1000)).toMatchObject({ verdict: 'owner' });
    expect(renewClaim(null, 5)).toBeNull();
  });

  it.each([
    ['a short room', `/r/${ROOM.slice(1)}?role=host`],
    ['a long room', `/r/${ROOM}A?role=host`],
    ['padding', `/r/${ROOM.slice(2)}==?role=host`],
    ['a non-base64url character', `/r/${ROOM.slice(1)}+?role=host`],
    ['a trailing segment', `/r/${ROOM}/x?role=host`],
    ['no role', `/r/${ROOM}`],
    ['an unknown role', `/r/${ROOM}?role=owner`],
  ])('refuses %s with 400', (_, url) => {
    expect(request({ url })).toMatchObject({ kind: 'reject', status: 400 });
  });

  it('requires a GET upgrade to a WebSocket', () => {
    expect(request({ upgrade: null })).toMatchObject({ kind: 'reject', status: 426, headers: { upgrade: 'websocket' } });
    expect(request({ upgrade: 'h2c' })).toMatchObject({ kind: 'reject', status: 426 });
    expect(request({ method: 'POST' })).toMatchObject({ kind: 'reject', status: 426 });
    expect(request({ upgrade: 'WebSocket' })).toMatchObject({ kind: 'connect' });
  });

  it('admits only the allowed origins', () => {
    for (const origin of DEFAULT_ORIGINS) expect(request({ origin })).toMatchObject({ kind: 'connect' });
    expect(request({ origin: null })).toMatchObject({ kind: 'reject', status: 403 });
    expect(request({ origin: 'https://evil.example' })).toMatchObject({ kind: 'reject', status: 403 });
    expect(request({ origin: 'http://localhost:5180' })).toMatchObject({ kind: 'reject', status: 403 });
  });

  it('admits loopback pages only when asked to (the dev relay)', () => {
    const origins = parseOrigins(undefined);
    for (const origin of ['http://localhost:5180', 'http://127.0.0.1:4173', 'http://localhost', 'http://[::1]:5198']) {
      expect(originAllowed(origin, origins, { loopback: true })).toBe(true);
      expect(originAllowed(origin, origins)).toBe(false);
    }
    for (const origin of ['https://localhost:5180', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example:80']) {
      expect(originAllowed(origin, origins, { loopback: true })).toBe(false);
    }
  });

  it('reads ALLOWED_ORIGINS, falling back to the defaults', () => {
    expect(parseOrigins(' https://a.example , https://b.example,')).toEqual(['https://a.example', 'https://b.example']);
    expect(parseOrigins('')).toEqual([...DEFAULT_ORIGINS]);
    expect(parseOrigins(' , ')).toEqual([...DEFAULT_ORIGINS]);
  });
});

describe('relay rooms', () => {
  it('gives each guest a private, well-formed tag', () => {
    const tags = new Set(Array.from({ length: 200 }, () => guestTag()));
    expect(tags.size).toBe(200);
    for (const tag of tags) expect(tag).toMatch(GUEST_TAG);
    // Bytes at 252 and above are skipped, never folded onto the low characters.
    expect(guestTag((bytes) => bytes.fill(255).fill(37, 0, 12))).toBe('g_111111111111');
  });

  it('greets the host and tells guests whether it is there', () => {
    const room = new FakeRoom();
    const early = room.guest();
    expect(early.sent).toEqual([{ event: 'host', present: false }]);
    const host = room.host();
    expect(host.sent).toEqual([{ event: 'ready' }]);
    expect(early.sent.at(-1)).toEqual({ event: 'host', present: true });
    const late = room.guest();
    expect(late.sent).toEqual([{ event: 'host', present: true }]);
    room.leave(host);
    expect(early.sent.at(-1)).toEqual({ event: 'host', present: false });
    expect(late.sent.at(-1)).toEqual({ event: 'host', present: false });
  });

  it('routes a guest to the host, tagged, and the host to one guest', () => {
    const room = new FakeRoom();
    const host = room.host();
    const a = room.guest();
    const b = room.guest();
    room.send(a, { to: 'host', data: 'knock' });
    expect(host.sent.at(-1)).toEqual({ from: tagOf(a), data: 'knock' });
    room.send(host, { to: tagOf(b), data: 'offer' });
    expect(b.sent.at(-1)).toEqual({ from: 'host', data: 'offer' });
    expect(a.sent).toEqual([{ event: 'host', present: true }]);
  });

  it('lets guests reach only the host', () => {
    const room = new FakeRoom();
    const host = room.host();
    const a = room.guest();
    const b = room.guest();
    room.send(a, { to: tagOf(b), data: 'hi' });
    room.send(a, { to: tagOf(a), data: 'hi' });
    expect(b.sent).toEqual([{ event: 'host', present: true }]);
    expect(host.sent).toEqual([{ event: 'ready' }]);
    expect(a.read().bad).toBe(2);
  });

  it('drops a frame for someone not there without holding it against the sender', () => {
    const room = new FakeRoom();
    const guest = room.guest();
    room.send(guest, { to: 'host', data: 'knock' });
    expect(guest.read().bad).toBe(0);
    const host = room.host();
    expect(host.sent).toEqual([{ event: 'ready' }]);
    room.send(host, { to: 'g_000000000000', data: 'answer' });
    expect(host.read().bad).toBe(0);
    room.send(host, { to: 'host', data: 'loop' });
    expect(host.read().bad).toBe(1);
  });

  it('tells the host when a guest leaves, however it goes', () => {
    const room = new FakeRoom();
    const host = room.host();
    const a = room.guest();
    const b = room.guest();
    room.leave(a);
    expect(host.sent.at(-1)).toEqual({ event: 'left', from: tagOf(a) });
    closePeer(room.open(), b, CLOSE.rate);
    expect(host.sent.at(-1)).toEqual({ event: 'left', from: tagOf(b) });
    // The client's close arriving afterwards is not a second departure.
    departed(room.open(), b);
    expect(host.sent.filter((frame) => (frame as { event?: string }).event === 'left')).toHaveLength(2);
  });

  it('holds one host at a time, and frees the slot when it leaves', () => {
    const room = new FakeRoom();
    const host = room.host();
    expect(room.join('host')).toEqual(CLOSE.hostTaken);
    room.leave(host);
    expect(room.join('host')).toHaveProperty('read');
  });

  it('holds 32 guests, then refuses with room-full', () => {
    const room = new FakeRoom();
    const guests = Array.from({ length: LIMITS.maxGuests }, () => room.guest());
    expect(new Set(guests.map(tagOf)).size).toBe(LIMITS.maxGuests);
    expect(room.join('guest')).toEqual(CLOSE.roomFull);
    room.leave(guests[0]!);
    expect(room.join('guest')).toHaveProperty('read');
    // The host has its own slot.
    expect(room.join('host')).toHaveProperty('read');
  });
});

describe('relay limits', () => {
  it('closes on a binary frame with 1003', () => {
    const room = new FakeRoom();
    const guest = room.guest();
    room.send(guest, null);
    expect(guest.closed).toEqual({ code: 1003, reason: 'binary' });
  });

  it('accepts 16384 characters of data and closes on a frame past 17 KB with 1009', () => {
    const room = new FakeRoom();
    const host = room.host();
    const guest = room.guest();
    const data = 'x'.repeat(LIMITS.maxData);
    room.send(guest, { to: 'host', data });
    expect(host.sent.at(-1)).toEqual({ from: tagOf(guest), data });
    room.send(guest, { to: 'host', data: `${data}x` });
    expect(guest.read().bad).toBe(1);
    expect(guest.closed).toBeNull();
    room.send(guest, JSON.stringify({ to: 'host', data: 'y'.repeat(LIMITS.maxFrame) }));
    expect(guest.closed).toEqual({ code: 1009, reason: 'too-large' });
    expect(host.sent.at(-1)).toEqual({ event: 'left', from: tagOf(guest) });
  });

  it.each([
    ['not JSON', '{"to":"host",'],
    ['an array', '["host","x"]'],
    ['a string', '"host"'],
    ['null', 'null'],
    ['a missing field', '{"to":"host"}'],
    ['an extra field', '{"to":"host","data":"x","v":1}'],
    ['a non-string data', '{"to":"host","data":1}'],
    ['a non-string to', '{"to":1,"data":"x"}'],
  ])('drops %s and counts it', (_, text) => {
    const room = new FakeRoom();
    const host = room.host();
    const guest = room.guest();
    room.send(guest, text);
    expect(host.sent).toEqual([{ event: 'ready' }]);
    expect(guest.read().bad).toBe(1);
    expect(guest.closed).toBeNull();
  });

  it('closes after more than 20 bad frames with 1008', () => {
    const room = new FakeRoom();
    const guest = room.guest();
    for (let i = 0; i < LIMITS.maxBadFrames; i++) room.send(guest, 'nope', i * 1000);
    expect(guest.closed).toBeNull();
    room.send(guest, 'nope', LIMITS.maxBadFrames * 1000);
    expect(guest.closed).toEqual({ code: 1008, reason: 'invalid' });
  });

  it('allows 30 messages per 10 s, refilling steadily, then closes with 1008 rate', () => {
    const room = new FakeRoom();
    const host = room.host();
    const guest = room.guest();
    for (let i = 0; i < LIMITS.rateMessages; i++) room.send(guest, { to: 'host', data: String(i) }, 0);
    expect(host.sent).toHaveLength(1 + LIMITS.rateMessages);
    // A third of a second later one token has come back (30 per 10 s).
    room.send(guest, { to: 'host', data: 'refilled' }, 334);
    expect(guest.closed).toBeNull();
    room.send(guest, { to: 'host', data: 'one too many' }, 335);
    expect(guest.closed).toEqual({ code: 1008, reason: 'rate' });
    expect(host.sent.at(-2)).toEqual({ from: tagOf(guest), data: 'refilled' });
  });

  it('lets one client hold only a few guest places, so a link holder can’t fill the room', () => {
    const room = new FakeRoom();
    for (let i = 0; i < LIMITS.maxGuestsPerClient; i++) expect(room.join('guest', 0, '203.0.113.9')).toHaveProperty('read');
    expect(room.join('guest', 0, '203.0.113.9')).toEqual(CLOSE.roomFull);
    // Everyone else still gets in.
    expect(room.join('guest', 0, '198.51.100.4')).toHaveProperty('read');
  });

  it('gives the host one guest’s budget for every guest, so answering knocks can’t get it closed', () => {
    const room = new FakeRoom();
    const host = room.host();
    const guests = Array.from({ length: 6 }, () => room.guest());
    // The owner greets each knock: far more than one socket's 30, all at once.
    for (let round = 0; round < 6; round++) {
      for (const guest of guests) room.send(host, { to: tagOf(guest), data: `seen ${round}` }, 10_000);
    }
    expect(host.closed).toBeNull();
    expect(guests.every((guest) => guest.sent.filter((frame) => (frame as { data?: string }).data?.startsWith('seen')).length === 6)).toBe(true);
  });

  it('counts bad and undeliverable frames against the rate too', () => {
    const room = new FakeRoom();
    const guest = room.guest();
    for (let i = 0; i < LIMITS.maxBadFrames; i++) room.send(guest, '{}', 0);
    // No host yet: dropped quietly, but still a message.
    for (let i = LIMITS.maxBadFrames; i < LIMITS.rateMessages; i++) room.send(guest, { to: 'host', data: '' }, 0);
    expect(guest.closed).toBeNull();
    room.send(guest, { to: 'host', data: '' }, 0);
    expect(guest.closed).toEqual({ code: 1008, reason: 'rate' });
  });

  it('ignores whatever a socket sends once it is being closed', () => {
    const room = new FakeRoom();
    const host = room.host();
    const guest = room.guest();
    guest.write({ ...guest.read(), gone: true });
    room.send(guest, { to: 'host', data: 'late' });
    expect(host.sent).toEqual([{ event: 'ready' }]);
    expect(live(room.open())).toEqual([host]);
  });
});

describe('relay lifetimes', () => {
  const minute = 60_000;

  it('closes a room after 15 minutes without a message', () => {
    const room = new FakeRoom();
    const host = room.host(0);
    const guest = room.guest(0);
    expect(deadline(room.open())).toBe(LIMITS.idleMs);
    room.send(guest, { to: 'host', data: 'knock' }, 5 * minute);
    expect(sweep(room.open(), LIMITS.idleMs)).toBe(5 * minute + LIMITS.idleMs);
    expect(host.closed).toBeNull();
    expect(sweep(room.open(), 5 * minute + LIMITS.idleMs)).toBeNull();
    expect(host.closed).toEqual({ code: 1001, reason: 'idle' });
    expect(guest.closed).toEqual({ code: 1001, reason: 'idle' });
    // Everyone left together: nobody was told about anybody else.
    expect(host.sent).toEqual([{ event: 'ready' }, { from: tagOf(guest), data: 'knock' }]);
  });

  it('keeps the room awake when its last speaker leaves', () => {
    const room = new FakeRoom();
    const host = room.host(0);
    const guest = room.guest(0);
    room.send(guest, { to: 'host', data: 'knock' }, 10 * minute);
    room.leave(guest);
    expect(sweep(room.open(), LIMITS.idleMs)).toBe(10 * minute + LIMITS.idleMs);
    expect(host.closed).toBeNull();
  });

  it('counts a new arrival as activity', () => {
    const room = new FakeRoom();
    room.host(0);
    room.guest(10 * minute);
    expect(sweep(room.open(), LIMITS.idleMs)).toBe(10 * minute + LIMITS.idleMs);
  });

  it('ends every room after 12 hours, however busy', () => {
    const room = new FakeRoom();
    const host = room.host(0);
    let now = 0;
    // Guests come and go, each inheriting the room's birth, so the room never looks new.
    for (; now < LIMITS.lifetimeMs - 10 * minute; now += 10 * minute) {
      const guest = room.guest(now);
      room.send(guest, { to: 'host', data: 'x' }, now);
      room.leave(guest);
      expect(sweep(room.open(), now)).not.toBeNull();
    }
    const last = room.guest(now);
    expect(last.read().born).toBe(0);
    expect(deadline(room.open())).toBe(LIMITS.lifetimeMs);
    expect(sweep(room.open(), LIMITS.lifetimeMs)).toBeNull();
    expect(host.closed).toEqual({ code: 1001, reason: 'expired' });
    expect(last.closed).toEqual({ code: 1001, reason: 'expired' });
  });

  it('has nothing to look at in an empty room', () => {
    expect(deadline([])).toBeNull();
    expect(sweep([], 0)).toBeNull();
  });
});
