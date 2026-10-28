import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Clock } from '../../src/collab/clock';
import { GONE_MS, HEARTBEAT_MS, HELLO_TIMEOUT_MS, HOLD_RETRY_MS, RESYNC_RETRY_MS, SILENT_MS } from '../../src/collab/clock';
import { diffFile } from '../../src/collab/diff';
import { GuestSession, type GuestEvents } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { encode, MAX_COLLABORATORS, PROTOCOL_VERSION, type PeerView } from '../../src/collab/protocol';
import { changeKeys, revertKeys } from '../../src/collab/selective';
import { indexOf } from '../../src/collab/fileIndex';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addFlow, createFlow, deleteFlow } from '../../src/document/flow';
import { addEdges, addNodes, removeElements, updateNode } from '../../src/document/operations';
import { CURRENT_VERSION, type DraftDocument } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair, randomEdit, rngFrom, seededFile } from './support';

/** A clock that only moves when told to, running due timers in order. */
function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

function ownerOf(file: DraftDocument, clock: Clock, extra: Partial<ConstructorParameters<typeof HostSession>[0]> = {}) {
  const state = { file, peers: [] as PeerView[] };
  const host = new HostSession(
    {
      readFile: () => state.file,
      applyRemote: (next) => {
        state.file = next;
        return true;
      },
      isBusy: () => false,
      appVersion: PRODUCT.version,
      ...extra,
    },
    { peers: (peers) => (state.peers = peers), presence: () => {} },
    { name: 'Owner' },
    clock,
  );
  return { host, state };
}

function guestOf(clock: Clock, options: { name?: string; busy?: () => boolean } = {}) {
  const state = { file: null as DraftDocument | null, statuses: [] as string[], reasons: [] as (string | undefined)[] };
  const events: GuestEvents = {
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
  };
  const session = new GuestSession(
    {
      readFile: () => state.file!,
      // Like the editor: a held gesture owns the file until it ends.
      applyRemote: (file) => {
        if (options.busy?.()) return false;
        state.file = file;
        return true;
      },
      isBusy: () => options.busy?.() ?? false,
      open: (file) => (state.file = file),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: options.name ?? 'Guest',
    },
    events,
    clock,
  );
  return { session, state };
}

function settle(pump: () => number) {
  for (let i = 0; i < 50 && pump() > 0; i += 1);
}

const base = () => addNodes(createDocument('Engine'), [createNode({ id: 'n_a', type: 'service', text: 'A', x: 0, y: 0 })]);

describe('the handshake', () => {
  it('refuses a copy that speaks a different protocol, or cannot read this document', () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    for (const hello of [
      { t: 'hello', v: PROTOCOL_VERSION + 1, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'x' },
      { t: 'hello', v: PROTOCOL_VERSION, app: '999.0.0', doc: CURRENT_VERSION, name: 'x' },
      { t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION - 1, name: 'x' },
    ]) {
      const { a, b, pump } = loopbackPair();
      host.attach(a, { role: 'editor' });
      const heard: string[] = [];
      b.onMessage((text) => heard.push(text));
      b.send(JSON.stringify(hello), 'commit');
      settle(pump);
      expect(heard).toEqual([encode({ t: 'end', reason: 'version' })]);
    }
  });

  it('closes a connection that never says hello', () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    const { a, b } = loopbackPair();
    host.attach(a, { role: 'editor' });
    clock.advance(HELLO_TIMEOUT_MS + 1000);
    expect(b.state).toBe('closed');
  });

  it(`holds at most ${MAX_COLLABORATORS} collaborators`, () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    const guests = Array.from({ length: MAX_COLLABORATORS + 1 }, () => {
      const pair = loopbackPair();
      host.attach(pair.a, { role: 'editor' });
      const guest = guestOf(clock);
      guest.session.connect(pair.b);
      settle(pair.pump);
      return guest;
    });
    expect(guests.slice(0, MAX_COLLABORATORS).every((guest) => guest.state.statuses.at(-1) === 'live')).toBe(true);
    expect(guests.at(-1)!.state.reasons.at(-1)).toBe('full');
  });
});

describe('coming back', () => {
  it('lets a dropped collaborator reclaim their place with its key, keeping their unsent edit', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    const id = guest.session.id;

    // An edit is made just as the connection drops; it never arrives.
    first.drop();
    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Made offline' });
    guest.session.localChanged();
    expect(owner.peers.find((peer) => peer.id === id)?.link).toBe('gone');

    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);
    expect(guest.session.id).toBe(id);
    expect(owner.file.nodes[0]!.text).toBe('Made offline');
    expect(owner.peers.filter((peer) => peer.role !== 'owner')).toHaveLength(1);
  });

  it('gives their place back for its key even while the old link still looks up from the owner’s side', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    const id = guest.session.id!;

    // They lost the link on their side first and knocked back in, as the lobby admits them: the
    // owner's side hasn't noticed yet. Refused, they were shut out of their own place.
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor', reuse: id, requireKey: true });
    second.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Guest', resume: { peer: id, key: guest.session.resumeKey!, seq: 0 } }), 'commit');
    settle(second.pump);
    expect(JSON.parse(second.sent.a[0]!)).toMatchObject({ t: 'welcome', peer: id });
    expect(first.a.state).toBe('closed');
    expect(owner.peers.filter((peer) => peer.role !== 'owner')).toHaveLength(1);
  });

  it('starts coming back as soon as the link degrades, not when the transport gives up', () => {
    // A network change strands an ICE restart signalled over the channel itself, so a session-link
    // guest's way back (`relayGuest.ts`, through the session's `lost`) must not wait for the 20 s close.
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    let degrade: (() => void) | null = null;
    const watched: typeof first.b = {
      ...first.b,
      get state() {
        return first.b.state;
      },
      onState(listener) {
        degrade = () => listener('degraded', 'disconnected');
        return first.b.onState(listener);
      },
    };
    const guest = guestOf(clock);
    guest.session.connect(watched);
    settle(first.pump);
    expect(guest.state.statuses.at(-1)).toBe('live');
    degrade!();
    expect(guest.state.statuses.at(-1)).toBe('reconnecting');
  });

  it('closes the connection a reconnect replaces, so it can’t hold a second place', () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    expect(first.b.state).toBe('closed');
  });

  it('takes the owner’s work back in after a gesture held across a reconnect, not over it', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    let busy = false;
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock, { busy: () => busy });
    guest.session.connect(first.b);
    settle(first.pump);

    first.drop();
    owner.file = addNodes(owner.file, [createNode({ id: 'n_new', type: 'note', x: 0, y: 200, text: 'Made while they were away' })]);
    host.commitLocal();
    // Mid-drag as the reconnect lands; the drop is written and sent as the drag ends.
    busy = true;
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);
    guest.state.file = updateNode(guest.state.file!, 'n_a', { x: 50 });
    busy = false;
    guest.session.localChanged();
    settle(second.pump);
    clock.advance(500);
    settle(second.pump);

    // Before: the drag ended over the stale file, and the diff sent the owner's new shape back out
    // as this person's deletion.
    expect(owner.file.nodes.map((node) => node.id).sort()).toEqual(['n_a', 'n_new']);
    expect(owner.file.nodes.find((node) => node.id === 'n_a')!.x).toBe(50);
    expect(guest.state.file!.nodes.map((node) => node.id).sort()).toEqual(['n_a', 'n_new']);
  });

  it('does not let anyone else claim a dropped place by its id alone', () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();

    const impostor = loopbackPair();
    host.attach(impostor.a, { role: 'viewer' });
    const heard: string[] = [];
    impostor.b.onMessage((text) => heard.push(text));
    impostor.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'x', resume: { peer: guest.session.id!, key: 'wrong', seq: 0 } }), 'commit');
    settle(impostor.pump);
    const welcome = JSON.parse(heard[0]!) as { t: string; peer: string; role: string };
    expect(welcome.t).toBe('welcome');
    expect(welcome.peer).not.toBe(guest.session.id);
    expect(welcome.role).toBe('viewer');
  });

  it('gives a re-invited collaborator back the same place, and nobody else', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    const id = guest.session.id!;
    host.setRole(id, 'viewer');
    settle(first.pump);
    first.drop();

    const again = loopbackPair();
    host.attach(again.a, { role: 'editor', reuse: id });
    guest.session.connect(again.b);
    settle(again.pump);
    expect(guest.session.id).toBe(id);
    expect(owner.peers.find((peer) => peer.id === id)?.role).toBe('viewer');
  });
});

it('refuses a welcome from a different session, so unsent edits never go to it, and keeps reconnecting', () => {
  const clock = manualClock();
  const first = ownerOf(base(), clock);
  const pair = loopbackPair();
  first.host.attach(pair.a, { role: 'editor' });
  const guest = guestOf(clock);
  guest.session.connect(pair.b);
  settle(pair.pump);
  pair.drop();
  guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Unsent' });
  guest.session.localChanged();

  // Someone else's invite, opened while reconnecting.
  const other = ownerOf(base(), clock);
  const stranger = loopbackPair();
  other.host.attach(stranger.a, { role: 'editor' });
  guest.session.connect(stranger.b);
  settle(stranger.pump);
  expect(other.state.file.nodes[0]!.text).toBe('A');
  expect(stranger.b.state).toBe('closed');
  // That link is closed; the session itself carries on, and comes back with its edit by its own owner.
  expect(guest.session.isEnded).toBe(false);
  const back = loopbackPair();
  first.host.attach(back.a, { role: 'editor' });
  guest.session.connect(back.b);
  settle(back.pump);
  expect(first.state.file.nodes[0]!.text).toBe('Unsent');
});

it('still lets someone in after many others have dropped', () => {
  const clock = manualClock();
  const { host } = ownerOf(base(), clock);
  for (let i = 0; i < 10; i += 1) {
    const pair = loopbackPair();
    host.attach(pair.a, { role: 'editor' });
    const guest = guestOf(clock, { name: `Gone ${i}` });
    guest.session.connect(pair.b);
    settle(pair.pump);
    pair.drop();
  }
  const pair = loopbackPair();
  host.attach(pair.a, { role: 'editor' });
  const late = guestOf(clock, { name: 'Late' });
  late.session.connect(pair.b);
  settle(pair.pump);
  expect(late.state.statuses.at(-1)).toBe('live');
});

describe('a quiet or abusive connection', () => {
  it('marks a silent collaborator as reconnecting, then gone', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Quiet' }), 'commit');
    settle(pump);
    clock.advance(SILENT_MS + HEARTBEAT_MS);
    expect(owner.peers[1]!.link).toBe('reconnecting');
    clock.advance(GONE_MS);
    expect(owner.peers[1]!.link).toBe('gone');
    expect(b.state).toBe('closed');
  });

  it('removes a collaborator that floods patches', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Loud' }), 'commit');
    settle(pump);
    for (let i = 1; i <= 1000; i += 1) b.send(encode({ t: 'patch', clientSeq: i, changes: [] }), 'commit');
    settle(pump);
    expect(owner.peers.filter((peer) => peer.role !== 'owner' && peer.link !== 'gone')).toHaveLength(0);
  });

  it('answers a ping flood with a few pongs', () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock);
    const { a, b, pump, sent } = loopbackPair();
    host.attach(a, { role: 'editor' });
    b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Loud' }), 'commit');
    settle(pump);
    for (let n = 1; n <= 50; n += 1) b.send(encode({ t: 'ping', n }), 'commit');
    settle(pump);
    expect(sent.a.filter((text) => text.startsWith('{"t":"pong"'))).toHaveLength(5);
    clock.advance(1000);
    b.send(encode({ t: 'ping', n: 51 }), 'commit');
    settle(pump);
    expect(sent.a.filter((text) => text.startsWith('{"t":"pong"'))).toHaveLength(6);
  });

  it('stops keeping one collaborator’s patches past what a held gesture may hold, and sends a fresh copy after it', () => {
    const clock = manualClock();
    let busy = true;
    const { host, state: owner } = ownerOf(base(), clock, { isBusy: () => busy });
    const { a, b, pump, sent } = loopbackPair();
    host.attach(a, { role: 'editor' });
    b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: CURRENT_VERSION, name: 'Busy' }), 'commit');
    settle(pump);
    // Within the patch rate, for longer than anyone holds a drag: more than the owner keeps.
    for (let i = 1; i <= 4200; i += 1) {
      b.send(encode({ t: 'patch', clientSeq: i, changes: [{ kind: 'title', value: `t${i}` }] }), 'commit');
      if (i % 20 === 0) {
        settle(pump);
        clock.advance(400);
      }
    }
    settle(pump);
    expect(owner.peers.find((peer) => peer.role !== 'owner')?.link).toBe('live');
    expect(sent.a.some((text) => text.startsWith('{"t":"snapshot"'))).toBe(false);

    busy = false;
    clock.advance(1000);
    settle(pump);
    // None of theirs was applied out of order; they were sent a copy, which makes them send again.
    expect(owner.file.metadata.title).toBe('Engine');
    expect(sent.a.filter((text) => text.startsWith('{"t":"snapshot"'))).toHaveLength(1);
  });

  it('asks for a fresh copy when a commit goes missing', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(b);
    settle(pump);
    const sent: string[] = [];
    const guestSend = b.send.bind(b);
    b.send = (text, priority) => {
      sent.push(text);
      return guestSend(text, priority);
    };
    // Commit 1 is lost on the way; commit 2 arrives.
    let lose = true;
    const hostSend = a.send.bind(a);
    a.send = (text, priority) => {
      if (lose && JSON.parse(text).t === 'commit') {
        lose = false;
        return true;
      }
      return hostSend(text, priority);
    };
    owner.file = updateNode(owner.file, 'n_a', { text: 'one' });
    host.commitLocal();
    owner.file = updateNode(owner.file, 'n_a', { text: 'two' });
    host.commitLocal();
    settle(pump);
    expect(sent.some((text) => JSON.parse(text).t === 'resync')).toBe(true);
    expect(guest.state.file!.nodes[0]!.text).toBe('two');
  });
});

describe('edits the editor holds but hasn’t sent', () => {
  it('takes back an unsent gesture after the owner revokes editing access', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    let busy = false;
    const guest = guestOf(clock, { busy: () => busy });
    guest.session.connect(b);
    settle(pump);

    busy = true;
    guest.state.file = updateNode(guest.state.file!, 'n_a', { x: 90 });
    host.setRole(guest.session.id!, 'viewer');
    settle(pump);
    expect(guest.session.role).toBe('viewer');
    expect(guest.state.file!.nodes[0]!.x).toBe(90);

    busy = false;
    clock.advance(HOLD_RETRY_MS);
    expect(guest.state.file!.nodes[0]!.x).toBe(0);
    expect(owner.file.nodes[0]!.x).toBe(0);
  });

  it('rolls back an oversized edit after its held gesture ends, even when no remote change arrives', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    let busy = false;
    const guest = guestOf(clock, { busy: () => busy });
    guest.session.connect(b);
    settle(pump);

    busy = true;
    guest.state.file = addNodes(guest.state.file!, Array.from({ length: 22 }, (_, i) =>
      createNode({ id: `code_${i}`, type: 'code', x: i * 300, y: 0, code: 'x'.repeat(199_000) }),
    ));
    guest.session.localChanged();
    expect(guest.state.file!.nodes).toHaveLength(23);
    expect(owner.file.nodes).toHaveLength(1);
    clock.advance(HOLD_RETRY_MS * 2);
    expect(guest.state.file!.nodes).toHaveLength(23);

    busy = false;
    clock.advance(HOLD_RETRY_MS);
    expect(guest.state.file!.nodes).toHaveLength(1);
    expect(guest.state.file!.nodes[0]!.text).toBe('A');

    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Still editable' });
    guest.session.localChanged();
    settle(pump);
    expect(owner.file.nodes[0]!.text).toBe('Still editable');
    expect(guest.state.file!.nodes[0]!.text).toBe('Still editable');
  });

  it('keeps pending valid edits and held owner commits when a later oversized gesture is taken back', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    let busy = false;
    const guest = guestOf(clock, { busy: () => busy });
    guest.session.connect(b);
    settle(pump);

    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Pending rename' });
    guest.session.localChanged();
    busy = true;
    guest.state.file = addNodes(guest.state.file!, Array.from({ length: 22 }, (_, i) =>
      createNode({ id: `code_${i}`, type: 'code', x: i * 300, y: 0, code: 'x'.repeat(199_000) }),
    ));
    guest.session.localChanged();
    owner.file = addNodes(owner.file, [createNode({ id: 'n_b', type: 'service', text: 'Owner addition', x: 300, y: 0 })]);
    host.commitLocal();
    settle(pump);

    busy = false;
    clock.advance(HOLD_RETRY_MS);
    settle(pump);
    expect(guest.state.file!.nodes.map((node) => node.text)).toEqual(['Pending rename', 'Owner addition']);
    expect(owner.file.nodes.map((node) => node.text)).toEqual(['Pending rename', 'Owner addition']);
  });

  it('sends a drop that an owner’s commit overtakes, instead of snapping it back', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(b);
    settle(pump);

    // The drop is on screen; the bridge sends it a moment later (its gesture timer), and the owner's
    // commit lands first.
    guest.state.file = updateNode(guest.state.file!, 'n_a', { x: 90 });
    owner.file = addNodes(owner.file, [createNode({ id: 'n_b', type: 'note', x: 0, y: 200, text: 'Owner' })]);
    host.commitLocal();
    settle(pump);
    guest.session.localChanged();
    settle(pump);

    expect(guest.state.file!.nodes.find((node) => node.id === 'n_a')!.x).toBe(90);
    expect(guest.state.file!.nodes.map((node) => node.id).sort()).toEqual(['n_a', 'n_b']);
    expect(owner.file.nodes.find((node) => node.id === 'n_a')!.x).toBe(90);
  });
});

describe('a lost fresh copy', () => {
  it('asks again when the snapshot it asked for never comes', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(b);
    settle(pump);
    // Commit 1 goes missing, and so does the snapshot that answers the request it causes (or the
    // owner, over its resync rate, drops the request without a word).
    const lose = new Set(['commit', 'snapshot']);
    const hostSend = a.send.bind(a);
    a.send = (text, priority) => {
      const kind = JSON.parse(text).t as string;
      if (lose.delete(kind)) return true;
      return hostSend(text, priority);
    };
    owner.file = updateNode(owner.file, 'n_a', { text: 'one' });
    host.commitLocal();
    owner.file = updateNode(owner.file, 'n_a', { text: 'two' });
    host.commitLocal();
    settle(pump);
    expect(guest.state.file!.nodes[0]!.text).toBe('A');

    clock.advance(RESYNC_RETRY_MS);
    settle(pump);
    expect(guest.state.file!.nodes[0]!.text).toBe('two');
  });
});

it('selective undo of a delete puts the element back where it was in its list', () => {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  let f0 = addNodes(createDocument('Order'), [a, b]);
  f0 = addEdges(f0, ['one', 'two', 'three'].map((label) => createEdge({ source: a.id, target: b.id, label })));
  for (const title of ['First', 'Second', 'Third']) f0 = addFlow(f0, createFlow({ title }));
  const middleEdge = f0.edges[1]!.id;
  const middleFlow = f0.flows[1]!.id;

  // The owner deletes the middle connector and the middle flow; a collaborator then adds a flow.
  const f1 = deleteFlow(removeElements(f0, [], [middleEdge]), middleFlow);
  const f2 = addFlow(f1, createFlow({ title: 'Theirs' }));

  const step = revertKeys(f2, f1, f0, changeKeys(f0, f1));
  expect(step.blocked).toBe(false);
  expect(step.file.edges.map((edge) => edge.label)).toEqual(['one', 'two', 'three']);
  expect(step.file.flows.map((flow) => flow.title)).toEqual(['First', 'Second', 'Third', 'Theirs']);
  // Redo takes them out again, leaving the collaborator's flow where it is.
  const redo = revertKeys(step.file, f0, f1, changeKeys(f0, f1));
  expect(redo.file.flows.map((flow) => flow.title)).toEqual(['First', 'Third', 'Theirs']);
});

it('selective undo restores several deleted items from the head of a list in their order', () => {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  let f0 = addNodes(createDocument('Order'), [a, b]);
  f0 = addEdges(f0, ['one', 'two', 'three'].map((label) => createEdge({ source: a.id, target: b.id, label })));
  for (const title of ['First', 'Second', 'Third']) f0 = addFlow(f0, createFlow({ title }));
  // Both at the head: each used to take the other, still parked at the end, as its next neighbour.
  const f1 = deleteFlow(deleteFlow(removeElements(f0, [], [f0.edges[0]!.id, f0.edges[1]!.id]), f0.flows[0]!.id), f0.flows[1]!.id);

  const step = revertKeys(f1, f1, f0, changeKeys(f0, f1));
  expect(step.blocked).toBe(false);
  expect(step.file.edges.map((edge) => edge.label)).toEqual(['one', 'two', 'three']);
  expect(step.file.flows.map((flow) => flow.title)).toEqual(['First', 'Second', 'Third']);
});

it('selective undo of any set of deletions restores the list order exactly', () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }), fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), (edgeMask, flowMask) => {
      const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
      const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
      let f0 = addNodes(createDocument('Order'), [a, b]);
      f0 = addEdges(f0, edgeMask.map((_, i) => createEdge({ source: a.id, target: b.id, label: `e${i}` })));
      flowMask.forEach((_, i) => { f0 = addFlow(f0, createFlow({ title: `f${i}` })); });
      let f1 = removeElements(f0, [], f0.edges.filter((_, i) => edgeMask[i]).map((edge) => edge.id));
      for (const flow of f0.flows.filter((_, i) => flowMask[i])) f1 = deleteFlow(f1, flow.id);

      const step = revertKeys(f1, f1, f0, changeKeys(f0, f1));
      expect(step.file.edges.map((edge) => edge.id)).toEqual(f0.edges.map((edge) => edge.id));
      expect(step.file.flows.map((flow) => flow.id)).toEqual(f0.flows.map((flow) => flow.id));
    }),
    { seed: 4242, numRuns: 200 },
  );
});

it('selective undo refuses to take away a connector somebody else changed, even one the undone edit added', () => {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const f0 = addNodes(createDocument('Theirs'), [a]);
  const added = createNode({ type: 'service', x: 0, y: 300, text: 'X' });
  const edge = createEdge({ source: added.id, target: a.id });
  // One step adds a shape and a connector from it; somebody else then labels the connector.
  const f1 = addEdges(addNodes(f0, [added]), [edge]);
  const f2 = { ...f1, edges: f1.edges.map((item) => (item.id === edge.id ? { ...item, label: 'Theirs now' } : item)) };

  const step = revertKeys(f2, f1, f0, changeKeys(f0, f1));
  expect(step).toMatchObject({ blocked: true, partial: true });
  expect(step.file).toBe(f2);
});

/**
 * Whatever a collaborator did after the owner's edit, undoing the owner's edit leaves everything only
 * the collaborator touched exactly as they left it, and removes nothing they touched at all. (An
 * element both touched may lose the owner's part of it — a flow keeps the collaborator's step and
 * drops the owner's — which is what undoing the owner's part means.)
 */
it('selective undo never changes what somebody else did', () => {
  fc.assert(
    fc.property(fc.integer(), fc.integer({ min: 1, max: 6 }), (seed, theirEdits) => {
      const rng = rngFrom(seed);
      const f0 = seededFile(rng, 10);
      // Real edits on both sides: the dice often pick something impossible, which changes nothing.
      const edited = (file: DraftDocument) => {
        let next = file;
        for (let tries = 0; next === file && tries < 30; tries += 1) next = randomEdit(file, rng);
        return next;
      };
      const f1 = edited(f0);
      let f2 = f1;
      for (let i = 0; i < theirEdits; i += 1) f2 = edited(f2);
      const step = revertKeys(f2, f1, f0, changeKeys(f0, f1));
      if (step.blocked) {
        expect(step.file).toBe(f2);
        return;
      }
      const theirs = changeKeys(f1, f2);
      const mine = new Set(changeKeys(f0, f1));
      const result = indexOf(step.file);
      const after = indexOf(f2);
      for (const key of theirs) {
        const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        if (kind !== 'node' && kind !== 'edge' && kind !== 'flow') continue;
        const map = kind === 'node' ? 'nodes' : kind === 'edge' ? 'edges' : 'flows';
        const now = after[map].get(id);
        const then = result[map].get(id);
        if (!now) continue;
        expect(then, `${key} survives`).toBeDefined();
        if (mine.has(key)) continue;
        expect(then!.room).toBe(now.room);
        if (kind === 'node') expect({ ...then!.value, inside: undefined }).toEqual({ ...now.value, inside: undefined });
        else expect(then!.value).toEqual(now.value);
      }
      // And the owner's own edit is gone wherever nobody touched it since.
      expect(diffFile(step.file, f2).every((change) => change.kind !== 'title' || changeKeys(f0, f1).includes('title'))).toBe(true);
    }),
    { seed: 4242, numRuns: 300 },
  );
});
