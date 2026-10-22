import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostLobby, type LobbyStatus } from '../../src/collab/lobby';
import { newOwnerIdentity, newSessionLink } from '../../src/collab/rendezvous';

/** A WebSocket that records how it was opened and lets the test decide what happens to it. */
class FakeSocket {
  static made: FakeSocket[] = [];
  readonly url: string;
  readonly protocols: string[];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.made.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() {}
  close() {}
  fire(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('the owner’s waiting room on the relay', () => {
  let statuses: LobbyStatus[];
  let lobby: HostLobby;

  beforeEach(async () => {
    vi.useFakeTimers();
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    statuses = [];
    const identity = await newOwnerIdentity();
    lobby = new HostLobby(newSessionLink(identity), identity, 'wss://relay.example', 'Olive', { localOnly: true, server: '' }, {
      status: (status) => statuses.push(status),
      knocks: () => {},
      admitted: () => {},
      isReturning: () => null,
      failed: () => {},
    });
    await lobby.open();
  });

  afterEach(async () => {
    await lobby.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('presents its own secret in the handshake, never in the address — and the same one when it comes back', async () => {
    const first = FakeSocket.made[0]!;
    expect(first.url).toMatch(/\/r\/[A-Za-z0-9_-]{22}\?role=host$/);
    expect(first.protocols).toHaveLength(2);
    expect(first.protocols[0]).toBe('draft-canvas.relay.v1');
    const secret = first.protocols[1]!;
    expect(secret).toMatch(/^host\.[A-Za-z0-9_-]{43}$/);
    expect(first.url).not.toContain(secret.slice(5));

    first.fire('open');
    expect(statuses.at(-1)).toBe('open');
    // The connection drops: it says it's reconnecting, and tries again on its own.
    first.fire('close', { code: 1006, reason: '' });
    expect(statuses.at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_100);
    const second = FakeSocket.made[1]!;
    expect(second.protocols).toEqual(first.protocols);
    second.fire('open');
    expect(statuses.at(-1)).toBe('open');
  });

  it('offers direct invites at once when the relay can’t be reached, and keeps trying', async () => {
    FakeSocket.made[0]!.fire('close', { code: 1006, reason: '' });
    expect(statuses.at(-1)).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeSocket.made).toHaveLength(2);
    FakeSocket.made[1]!.fire('open');
    expect(statuses.at(-1)).toBe('open');
  });

  it('gives up for good when the relay says the room is someone else’s', async () => {
    FakeSocket.made[0]!.fire('close', { code: 4003, reason: 'not-owner' });
    expect(statuses.at(-1)).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });
});

describe('the door, against junk', () => {
  it('turns away a knock whose key isn’t a real curve point, without it taking a place', async () => {
    vi.useFakeTimers();
    FakeSocket.made = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    const { roomKey, seal, toBase64Url } = await import('../../src/collab/rendezvous');
    const identity = await newOwnerIdentity();
    const link = newSessionLink(identity);
    const seen: unknown[] = [];
    const lobby = new HostLobby(link, identity, 'wss://relay.example', 'Olive', { localOnly: true, server: '' }, {
      status: () => {},
      knocks: (knocks) => seen.push(knocks),
      admitted: () => {},
      isReturning: () => null,
      failed: () => {},
    });
    await lobby.open();
    const socket = FakeSocket.made[0]!;
    socket.fire('open');
    const key = await roomKey(link);
    // 0x04 and 64 random bytes: the right shape, but not a point on P-256.
    const bogus = new Uint8Array(65);
    bogus[0] = 4;
    for (let i = 1; i < 65; i += 1) bogus[i] = (i * 37) % 251;
    for (let n = 0; n < 15; n += 1) {
      const data = await seal(key, 'to-host', { t: 'knock', name: `Junk ${n}`, publicKey: toBase64Url(bogus) });
      socket.fire('message', { data: JSON.stringify({ from: `g_junk${String(n).padStart(8, '0')}`, data }) });
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(lobby.list()).toEqual([]);
    // A real knock still gets a place at the door.
    const real = await (await import('../../src/collab/rendezvous')).newExchange();
    socket.fire('message', { data: JSON.stringify({ from: 'g_realknocker1', data: await seal(key, 'to-host', { t: 'knock', name: 'Ada', publicKey: real.publicKey }) }) });
    await vi.waitFor(() => expect(lobby.list().map((knock) => knock.name)).toEqual(['Ada']));
    await lobby.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
