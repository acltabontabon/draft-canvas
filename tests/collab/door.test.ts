import { describe, expect, it, vi } from 'vitest';
import { holdAtDoor, returningPlace } from '../../src/collab/door';
import { GuestSession } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { encode, PROTOCOL_VERSION } from '../../src/collab/protocol';
import { CURRENT_VERSION } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair } from './support';

function settle(pump: () => number) {
  for (let i = 0; i < 50 && pump() > 0; i += 1);
}

function guest(transport: ReturnType<typeof loopbackPair>['b']) {
  const state = { file: null as DraftDocument | null, statuses: [] as string[], reasons: [] as (string | undefined)[] };
  const session = new GuestSession(
    {
      readFile: () => state.file!,
      applyRemote: (file) => ((state.file = file), true),
      isBusy: () => false,
      open: (file) => (state.file = file),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: 'Neighbour',
    },
    {
      status: (status, reason) => {
        state.statuses.push(status);
        state.reasons.push(reason);
      },
      joined: () => {},
      peers: () => {},
      presence: () => {},
      presenter: () => {},
      rejected: () => {},
      unconfirmed: () => {},
      tooLarge: () => {},
    },
  );
  session.connect(transport);
  return { session, state };
}

describe('the local network door', () => {
  it('rejects large frames before admission and bounds heartbeat replies while waiting', async () => {
    const oversized = loopbackPair();
    const rejected = holdAtDoor(oversized.a);
    oversized.b.send(' '.repeat(4097), 'commit');
    oversized.pump();
    expect(await rejected).toBeNull();
    expect(oversized.b.state).toBe('closed');

    const waiting = loopbackPair();
    const pending = holdAtDoor(waiting.a);
    waiting.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Visitor' }), 'commit');
    waiting.pump();
    const door = (await pending)!;
    for (let n = 0; n < 50; n += 1) waiting.b.send(encode({ t: 'ping', n }), 'commit');
    waiting.pump();
    expect(waiting.sent.a.filter((text) => JSON.parse(text).t === 'pong')).toHaveLength(5);
    // The disconnect happened before the UI could install its listener: still remove the knock.
    waiting.b.send(' '.repeat(4097), 'commit');
    waiting.pump();
    const gone = vi.fn();
    door.onGone(gone);
    expect(gone).toHaveBeenCalledOnce();
  });

  it('holds someone until the owner lets them in, then joins them as if nothing waited', async () => {
    let owner = addNodes(createDocument('LAN'), [createNode({ type: 'service', x: 0, y: 0, text: 'A' })]);
    const host = new HostSession(
      { readFile: () => owner, applyRemote: (file) => ((owner = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const { a, b, pump } = loopbackPair();
    const waiting = holdAtDoor(a);
    const neighbour = guest(b);
    settle(pump);
    const door = await waiting;
    expect(door?.name).toBe('Neighbour');
    // Waiting, they are not in the session and have no copy of the diagram.
    expect(neighbour.state.file).toBeNull();
    host.attach(door!.admit(), { role: 'viewer' });
    await Promise.resolve();
    settle(pump);
    expect(neighbour.state.statuses.at(-1)).toBe('live');
    expect(neighbour.state.file!.nodes).toHaveLength(1);
    host.end();
  });

  it('tells someone turned away so, and never lets them see the diagram', async () => {
    vi.useFakeTimers();
    const { a, b, pump } = loopbackPair();
    const waiting = holdAtDoor(a);
    const neighbour = guest(b);
    settle(pump);
    (await waiting)!.refuse();
    settle(pump);
    expect(neighbour.state.reasons.at(-1)).toBe('denied');
    expect(neighbour.state.file).toBeNull();
    vi.useRealTimers();
  });

  it('never lets a replayed resume key back in unasked: the owner sees the knock and chooses the role', async () => {
    let owner = addNodes(createDocument('LAN'), [createNode({ type: 'service', x: 0, y: 0, text: 'A' })]);
    let peers: { id: string; role: string; link: string }[] = [];
    const host = new HostSession(
      { readFile: () => owner, applyRemote: (file) => ((owner = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: (next) => (peers = next), presence: () => {} },
      { name: 'Owner' },
    );
    const first = loopbackPair('socket');
    const knocking = holdAtDoor(first.a);
    const neighbour = guest(first.b);
    settle(first.pump);
    host.attach((await knocking)!.admit(), { role: 'editor' });
    await Promise.resolve();
    settle(first.pump);
    const placeId = neighbour.session.id!;
    expect(peers.find((peer) => peer.id === placeId)?.role).toBe('editor');

    // The neighbour drops. Someone else on the Wi‑Fi saw their reconnecting hello — the key in clear.
    first.drop();
    const retry = loopbackPair();
    neighbour.session.connect(retry.b);
    const sniffed = JSON.parse(retry.sent.b[0]!) as { resume: { peer: string; key: string } };
    expect(sniffed.resume).toMatchObject({ peer: placeId, key: neighbour.session.resumeKey });

    const replay = loopbackPair();
    const atDoor = holdAtDoor(replay.a);
    replay.b.send(JSON.stringify({ ...sniffed, name: 'Neighbour' }), 'commit');
    settle(replay.pump);
    const door = (await atDoor)!;
    // Held at the door, not in the session: the place is still empty.
    expect(peers.find((peer) => peer.id === placeId)?.link).toBe('gone');
    const back = returningPlace(door, (peer) => host.waitingPlace(peer, { evenIfLive: true, exposed: true }));
    expect(back).toEqual({ peer: placeId, role: 'editor' });
    // A wrong key is just a new person knocking.
    expect(returningPlace({ ...door, returning: { peer: placeId, key: 'f'.repeat(32) } }, (peer) => host.waitingPlace(peer, { evenIfLive: true, exposed: true }))).toBeNull();

    // The owner lets them in, but only to watch: their old place, with the role chosen now (as `LanShare` does).
    host.setRole(back!.peer, 'viewer');
    host.attach(door.admit(), { role: 'viewer', reuse: back!.peer, requireKey: true });
    await Promise.resolve();
    settle(replay.pump);
    expect(peers.find((peer) => peer.id === placeId)).toMatchObject({ role: 'viewer', link: 'live' });
    host.end();
  });

  it('never takes a key that crossed the local network as proof anywhere else', async () => {
    let owner = addNodes(createDocument('LAN'), [createNode({ type: 'service', x: 0, y: 0, text: 'A' })]);
    let peers: { id: string; role: string; link: string }[] = [];
    const host = new HostSession(
      { readFile: () => owner, applyRemote: (file) => ((owner = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: (next) => (peers = next), presence: () => {} },
      { name: 'Owner' },
    );
    const lan = loopbackPair('socket');
    const neighbour = guest(lan.b);
    host.attach(lan.a, { role: 'editor' });
    settle(lan.pump);
    const placeId = neighbour.session.id!;
    const key = neighbour.session.resumeKey!;
    expect(peers.find((peer) => peer.id === placeId)?.role).toBe('editor');

    // Their welcome crossed the Wi‑Fi in clear. The relay's door must not let the key in unasked…
    expect(host.waitingPlace(placeId, { evenIfLive: true })).toBeNull();
    expect(host.waitingPlace(placeId, { evenIfLive: true, exposed: true })).toEqual({ role: 'editor', key });

    // …and a direct invite for a viewer, replaying it, is a new person with the invite's role, not a takeover.
    const invited = loopbackPair('webrtc');
    host.attach(invited.a, { role: 'viewer' });
    invited.b.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Mallory', resume: { peer: placeId, key, seq: 0 } }), 'commit');
    settle(invited.pump);
    const welcome = invited.sent.a.map((text) => JSON.parse(text) as { t: string; peer?: string; role?: string }).find((message) => message.t === 'welcome');
    expect(welcome).toMatchObject({ role: 'viewer' });
    expect(welcome?.peer).not.toBe(placeId);
    expect(peers.find((peer) => peer.id === placeId)).toMatchObject({ role: 'editor', link: 'live' });
    host.end();
  });

  it('drops a connection that never says hello', async () => {
    vi.useFakeTimers();
    const { a } = loopbackPair();
    const waiting = holdAtDoor(a, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await waiting).toBeNull();
    expect(a.state).toBe('closed');
    vi.useRealTimers();
  });
});
