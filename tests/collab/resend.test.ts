import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/collab/clock';
import { GuestSession, type GuestEvents } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { MAX_PENDING_PATCHES } from '../../src/collab/replica';
import type { PeerView } from '../../src/collab/protocol';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import type { DraftDocument, DraftInside } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair } from './support';

/**
 * Edits that cross a fresh copy of the file — a reconnect, a re-invite, a copy sent after the owner's
 * long gesture — each reach the owner once, in order: none skipped as a repeat, none applied twice.
 */

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, run });
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
        due[1].run();
      }
      now = until;
    },
  };
}

function ownerOf(file: DraftDocument, clock: Clock, isBusy: () => boolean = () => false) {
  const state = { file, peers: [] as PeerView[] };
  const host = new HostSession(
    { readFile: () => state.file, applyRemote: (next) => ((state.file = next), true), isBusy, appVersion: PRODUCT.version },
    { peers: (peers) => (state.peers = peers), presence: () => {} },
    { name: 'Owner' },
    clock,
  );
  return { host, state };
}

function guestOf(clock: Clock, busy: () => boolean = () => false) {
  const state = { file: null as DraftDocument | null, ended: null as string | null, tooLarge: 0 };
  const events: GuestEvents = {
    status: (status, reason) => {
      if (status === 'ended') state.ended = reason ?? 'ended';
    },
    joined: () => {},
    peers: () => {},
    presence: () => {},
    presenter: () => {},
    rejected: () => {},
    unconfirmed: () => {},
    tooLarge: () => (state.tooLarge += 1),
  };
  const session = new GuestSession(
    {
      readFile: () => state.file!,
      applyRemote: (file) => (busy() ? false : ((state.file = file), true)),
      isBusy: busy,
      open: (file) => (state.file = file),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: 'Guest',
    },
    events,
    clock,
  );
  return { session, state };
}

const settle = (pump: () => number) => {
  for (let i = 0; i < 50 && pump() > 0; i += 1);
};

const base = () =>
  addNodes(createDocument('Resend'), [
    createNode({ id: 'n_a', type: 'service', text: 'A', x: 0, y: 0 }),
    createNode({ id: 'n_b', type: 'service', text: 'B', x: 300, y: 0 }),
  ]);

const textOf = (file: DraftDocument, id: string) => file.nodes.find((node) => node.id === id)?.text;

describe('edits across a fresh copy', () => {
  it('keeps an edit made offline when a newer one is sent first after reconnecting', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);

    first.drop();
    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Made offline' });
    guest.session.localChanged();
    // Still waiting on the bridge's gesture timer when the welcome lands.
    guest.state.file = updateNode(guest.state.file!, 'n_b', { text: 'Unsent' });

    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);
    clock.advance(500);
    settle(second.pump);

    expect(textOf(owner.file, 'n_a')).toBe('Made offline');
    expect(textOf(owner.file, 'n_b')).toBe('Unsent');
    expect(guest.state.file).toEqual(owner.file);
  });

  it('keeps an edit made offline when a held drag streams newer ones before the welcome is taken in', () => {
    const clock = manualClock();
    let busy = false;
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock, () => busy);
    guest.session.connect(first.b);
    settle(first.pump);

    first.drop();
    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Made offline' });
    guest.session.localChanged();
    busy = true;
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);
    guest.state.file = updateNode(guest.state.file!, 'n_b', { x: 99 });
    guest.session.localChanged();
    settle(second.pump);
    busy = false;
    clock.advance(500);
    settle(second.pump);

    expect(textOf(owner.file, 'n_a')).toBe('Made offline');
    expect(owner.file.nodes.find((node) => node.id === 'n_b')?.x).toBe(99);
  });

  it('sends hundreds of offline edits as one patch rather than tripping the rate limit', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();
    // Fifteen seconds of dragging while the link is down, flushed every 50 ms.
    for (let i = 1; i <= 300; i += 1) {
      clock.advance(50);
      guest.state.file = updateNode(guest.state.file!, 'n_a', { x: i });
      guest.session.localChanged();
    }
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);

    expect(guest.state.ended).toBeNull();
    expect(owner.file.nodes.find((node) => node.id === 'n_a')?.x).toBe(300);
    expect(second.sent.b.filter((text) => text.includes('"t":"patch"'))).toHaveLength(1);
  });

  it('bounds unconfirmed edits during a long outage, keeps earlier work, and accepts edits again after reconnecting', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();

    for (let i = 1; i <= MAX_PENDING_PATCHES + 1; i += 1) {
      guest.state.file = updateNode(guest.state.file!, 'n_a', { x: i });
      guest.session.localChanged();
    }
    expect(guest.state.tooLarge).toBe(1);
    expect(guest.state.file!.nodes[0]!.x).toBe(MAX_PENDING_PATCHES);

    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);
    expect(guest.state.file).toEqual(owner.file);
    expect(owner.file.nodes[0]!.x).toBe(MAX_PENDING_PATCHES);
    guest.state.file = updateNode(guest.state.file!, 'n_a', { x: MAX_PENDING_PATCHES + 2 });
    guest.session.localChanged();
    settle(second.pump);
    expect(owner.file.nodes[0]!.x).toBe(MAX_PENDING_PATCHES + 2);
    expect(guest.state.tooLarge).toBe(1);
  });

  it('paces Unicode offline work by UTF-8 bytes so the relay and owner do not reject the resend as a flood', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();
    for (let i = 0; i < 20; i += 1) {
      guest.state.file = addNodes(guest.state.file!, [createNode({ id: `n_unicode${i}`, type: 'code', x: i * 300, y: 600, code: `${i}${'界'.repeat(190_000)}` })]);
      guest.session.localChanged();
    }
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    for (let i = 0; i < 30; i += 1) {
      settle(second.pump);
      clock.advance(1000);
    }
    settle(second.pump);
    expect(guest.state.ended).toBeNull();
    expect(guest.state.tooLarge).toBe(0);
    expect(owner.file.nodes.filter((node) => node.id.startsWith('n_unicode'))).toHaveLength(20);
    expect(guest.state.file).toEqual(owner.file);
  });

  it('numbers a re-invited fresh page on from where its place left off', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    const id = guest.session.id!;
    for (let i = 1; i <= 3; i += 1) {
      guest.state.file = updateNode(guest.state.file!, 'n_a', { x: i });
      guest.session.localChanged();
      settle(first.pump);
    }
    // They closed the tab; the owner re-invites them to their place.
    first.drop();
    const again = loopbackPair();
    host.attach(again.a, { role: 'editor', reuse: id });
    const fresh = guestOf(clock);
    fresh.session.connect(again.b);
    settle(again.pump);
    expect(fresh.session.id).toBe(id);
    fresh.state.file = updateNode(fresh.state.file!, 'n_b', { text: 'After re-invite' });
    fresh.session.localChanged();
    settle(again.pump);

    expect(textOf(owner.file, 'n_b')).toBe('After re-invite');
  });

  it('brings unconfirmed edits along when the owner has forgotten the place, rather than dropping them unsaid', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    const id = guest.session.id!;
    first.drop();
    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Made offline' });
    guest.session.localChanged();
    // Eleven others come and go meanwhile: the owner keeps only the ten most recent dropped places.
    for (let i = 0; i < 11; i += 1) {
      clock.advance(10);
      const other = loopbackPair();
      host.attach(other.a, { role: 'editor' });
      guestOf(clock).session.connect(other.b);
      settle(other.pump);
      other.drop();
    }
    const back = loopbackPair();
    host.attach(back.a, { role: 'editor' });
    guest.session.connect(back.b);
    settle(back.pump);

    expect(guest.session.id).not.toBe(id);
    expect(textOf(owner.file, 'n_a')).toBe('Made offline');
    expect(textOf(guest.state.file!, 'n_a')).toBe('Made offline');
  });

  it('asks for a fresh copy instead of holding commits without end through a very long drag', () => {
    const clock = manualClock();
    let busy = false;
    const { host, state: owner } = ownerOf(base(), clock);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    const guest = guestOf(clock, () => busy);
    guest.session.connect(b);
    settle(pump);
    busy = true;
    for (let i = 1; i <= 5000; i += 1) {
      owner.file = { ...owner.file, metadata: { ...owner.file.metadata, title: `t${i}` } };
      host.commitLocal();
      settle(pump);
    }
    expect((guest.session as unknown as { held: unknown[] }).held.length).toBeLessThanOrEqual(4096);
    busy = false;
    clock.advance(500);
    settle(pump);
    clock.advance(500);
    settle(pump);
    expect(guest.state.file!.metadata.title).toBe('t5000');
  });

  it('sends offline work too large for one message as several, paced, and loses none of it', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();
    // Two dozen large snippets pasted while away: each fits a message, together they don't.
    for (let i = 0; i < 24; i += 1) {
      guest.state.file = addNodes(guest.state.file!, [createNode({ id: `n_code${i}`, type: 'code', x: i * 300, y: 600, code: `${i}`.padEnd(190_000, 'x') })]);
      guest.session.localChanged();
    }
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    for (let i = 0; i < 20; i += 1) {
      settle(second.pump);
      clock.advance(1000);
    }
    settle(second.pump);

    expect(guest.state.ended).toBeNull();
    expect(guest.state.tooLarge).toBe(0);
    expect(owner.file.nodes.filter((node) => node.id.startsWith('n_code'))).toHaveLength(24);
    expect(guest.state.file).toEqual(owner.file);
  });

  it('never lets a new edit overtake unconfirmed work still being paced out', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();
    for (let batch = 0; batch < 4; batch += 1) {
      const notes = Array.from({ length: 90 }, (_, i) => createNode({ id: `big_${batch}_${i}`, type: 'note', text: 'q'.repeat(19_500), x: i, y: batch * 100 }));
      guest.state.file = addNodes(guest.state.file!, notes);
      guest.session.localChanged();
    }
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    settle(second.pump);
    // A quick rename right after the welcome, while the rest of the offline work waits its turn.
    guest.state.file = updateNode(guest.state.file!, 'n_a', { text: 'Renamed after reconnect' });
    guest.session.localChanged();
    for (let i = 0; i < 30; i += 1) {
      settle(second.pump);
      clock.advance(1000);
    }
    expect(owner.file.nodes.filter((node) => node.id.startsWith('big_'))).toHaveLength(360);
    expect(textOf(owner.file, 'n_a')).toBe('Renamed after reconnect');
    expect(guest.state.file).toEqual(owner.file);
  });

  it('keeps every edit after rejoining as someone new, one made before the welcome included', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    for (let i = 1; i <= 50; i += 1) {
      guest.state.file = { ...guest.state.file!, metadata: { ...guest.state.file!.metadata, title: `t${i}` } };
      guest.session.localChanged();
      settle(first.pump);
    }
    first.drop();
    // Reconnecting, an edit made while the hello is on its way — and the place is forgotten meanwhile.
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    guest.state.file = addNodes(guest.state.file!, [createNode({ id: 'w_pre', type: 'note', text: 'pre', x: 0, y: 200 })]);
    guest.session.localChanged();
    for (let i = 0; i < 11; i += 1) {
      clock.advance(10);
      const other = loopbackPair();
      host.attach(other.a, { role: 'editor' });
      guestOf(clock).session.connect(other.b);
      settle(other.pump);
      other.drop();
    }
    settle(second.pump);
    for (let i = 1; i <= 10; i += 1) {
      guest.state.file = addNodes(guest.state.file!, [createNode({ id: `w_after_${i}`, type: 'note', text: `after ${i}`, x: 0, y: 300 + i })]);
      guest.session.localChanged();
      settle(second.pump);
    }
    const ids = owner.file.nodes.map((node) => node.id);
    expect(ids).toContain('w_pre');
    for (let i = 1; i <= 10; i += 1) expect(ids).toContain(`w_after_${i}`);
    expect(guest.state.file).toEqual(owner.file);
  });

  it('splits and paces offline moves to stay inside what the owner takes in one patch, and loses none', () => {
    const clock = manualClock();
    const notes = Array.from({ length: 1200 }, (_, i) => createNode({ id: `m_${i}`, type: 'note', text: `m${i}`, x: i, y: 0 }));
    const { host, state: owner } = ownerOf(addNodes(base(), [createNode({ id: 'box', type: 'service', text: 'Box', x: 0, y: 400 }), ...notes]), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();
    // Two edits while away, each moving 600 notes into the box: each fits, together they don't.
    for (const half of [notes.slice(0, 600), notes.slice(600)]) {
      const moving = new Set(half.map((note) => note.id));
      const file = guest.state.file!;
      const box = file.nodes.find((node) => node.id === 'box')!;
      const inside: DraftInside = box.inside ?? { nodes: [], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
      guest.state.file = {
        ...file,
        nodes: file.nodes.filter((node) => !moving.has(node.id)).map((node) => (node.id === 'box' ? { ...node, inside: { ...inside, nodes: [...inside.nodes, ...file.nodes.filter((n) => moving.has(n.id))] } } : node)),
      };
      guest.session.localChanged();
    }
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    for (let i = 0; i < 10; i += 1) {
      settle(second.pump);
      clock.advance(1000);
    }
    expect(second.sent.a.some((text) => text.includes('"rejected"'))).toBe(false);
    expect(owner.file.nodes.find((node) => node.id === 'box')!.inside?.nodes).toHaveLength(1200);
    expect(guest.state.file).toEqual(owner.file);
  });

  it('keeps large offline work whole when it comes back as someone new', () => {
    const clock = manualClock();
    const { host, state: owner } = ownerOf(base(), clock);
    const first = loopbackPair();
    host.attach(first.a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(first.b);
    settle(first.pump);
    first.drop();
    for (let i = 0; i < 24; i += 1) {
      guest.state.file = addNodes(guest.state.file!, [createNode({ id: `n_code${i}`, type: 'code', x: i * 300, y: 600, code: `${i}`.padEnd(190_000, 'x') })]);
      guest.session.localChanged();
    }
    // Others come and go meanwhile: the place is forgotten.
    for (let i = 0; i < 11; i += 1) {
      clock.advance(10);
      const other = loopbackPair();
      host.attach(other.a, { role: 'editor' });
      guestOf(clock).session.connect(other.b);
      settle(other.pump);
      other.drop();
    }
    const second = loopbackPair();
    host.attach(second.a, { role: 'editor' });
    guest.session.connect(second.b);
    for (let i = 0; i < 20; i += 1) {
      settle(second.pump);
      clock.advance(1000);
    }
    expect(guest.state.tooLarge).toBe(0);
    expect(owner.file.nodes.filter((node) => node.id.startsWith('n_code'))).toHaveLength(24);
  });

  it('never applies a patch in flight past the copy sent after a long gesture, ahead of the ones it dropped', () => {
    const clock = manualClock();
    let busy = true;
    const { host, state: owner } = ownerOf(base(), clock, () => busy);
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    const guest = guestOf(clock);
    guest.session.connect(b);
    settle(pump);

    // The owner holds a gesture for so long that this person's patches stop being kept.
    guest.state.file = addNodes(guest.state.file!, [createNode({ id: 'n_x', type: 'note', text: 'X', x: 0, y: 400 })]);
    guest.session.localChanged();
    for (let i = 1; i <= 4200; i += 1) {
      guest.state.file = { ...guest.state.file!, metadata: { ...guest.state.file!.metadata, title: `t${i}` } };
      guest.session.localChanged();
      if (i % 20 === 0) {
        settle(pump);
        clock.advance(400);
      }
    }
    settle(pump);
    busy = false;
    // The gesture ends: a fresh copy goes out — and their next edit is already on the wire.
    clock.advance(1000);
    guest.state.file = { ...guest.state.file!, metadata: { ...guest.state.file!.metadata, title: 'final' } };
    guest.session.localChanged();
    settle(pump);
    clock.advance(1000);
    settle(pump);

    expect(owner.file.nodes.some((node) => node.id === 'n_x')).toBe(true);
    expect(owner.file.metadata.title).toBe('final');
    expect(guest.state.file).toEqual(owner.file);
  });
});
