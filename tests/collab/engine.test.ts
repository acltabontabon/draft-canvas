import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Clock } from '../../src/collab/clock';
import { GONE_MS, HEARTBEAT_MS, HELLO_TIMEOUT_MS, SILENT_MS } from '../../src/collab/clock';
import { diffFile } from '../../src/collab/diff';
import { GuestSession, type GuestEvents } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { encode, MAX_COLLABORATORS, PROTOCOL_VERSION, type PeerView } from '../../src/collab/protocol';
import { changeKeys, revertKeys } from '../../src/collab/selective';
import { indexOf } from '../../src/collab/fileIndex';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
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

function guestOf(clock: Clock, options: { token?: string; name?: string } = {}) {
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
      applyRemote: (file) => {
        state.file = file;
        return true;
      },
      isBusy: () => false,
      open: (file) => (state.file = file),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: options.name ?? 'Guest',
      ...(options.token === undefined ? {} : { token: options.token }),
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

  it('refuses a LAN connection without the session’s secret', () => {
    const clock = manualClock();
    const { host } = ownerOf(base(), clock, { checkToken: (token) => token === 'secret' });
    const wrong = loopbackPair();
    host.attach(wrong.a, { role: 'editor' });
    const intruder = guestOf(clock, { token: 'guess' });
    intruder.session.connect(wrong.b);
    settle(wrong.pump);
    expect(intruder.state.reasons.at(-1)).toBe('unauthorized');

    const right = loopbackPair();
    host.attach(right.a, { role: 'editor' });
    const friend = guestOf(clock, { token: 'secret' });
    friend.session.connect(right.b);
    settle(right.pump);
    expect(friend.state.statuses.at(-1)).toBe('live');
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

it('refuses a welcome from a different session, so unsent edits never go to it', () => {
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
  expect(guest.state.reasons.at(-1)).toBe('unauthorized');
  expect(other.state.file.nodes[0]!.text).toBe('A');
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
