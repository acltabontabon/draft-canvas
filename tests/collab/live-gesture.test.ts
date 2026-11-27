import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/collab/clock';
import { GuestSession } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { createDocument, createNode } from '../../src/document/factory';
import { makeRoom } from '../../src/document/makeRoom';
import { addNodes } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair, sharedContent } from './support';

/**
 * A gesture a collaborator holds (Make room, a slider) is streamed to everyone while it lasts, every
 * 50 ms as the bridge sends it (`GESTURE_SEND_MS` in `collabBridge.ts`), and each of those patches
 * carries everything the gesture has moved so far. However large the diagram, that stream must stay
 * inside what the owner takes from one person — which the owner enforces by cutting them off — and
 * the gesture must still end on exactly where they let go.
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

/** An owner and one collaborator on an instant link, the collaborator's editor busy while `held()`. */
function session(file: DraftDocument, clock: Clock, held: () => boolean) {
  const owner = { file };
  const host = new HostSession(
    { readFile: () => owner.file, applyRemote: (next) => ((owner.file = next), true), isBusy: () => false, appVersion: PRODUCT.version },
    { peers: () => {}, presence: () => {} },
    { name: 'Owner' },
    clock,
  );
  const guest = { file: null as DraftDocument | null, ended: null as string | null };
  const collaborator = new GuestSession(
    {
      readFile: () => guest.file!,
      applyRemote: (next) => (held() ? false : ((guest.file = next), true)),
      isBusy: held,
      open: (next) => (guest.file = next),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: 'Grace',
    },
    {
      status: (status, reason) => {
        if (status === 'ended') guest.ended = reason ?? 'ended';
      },
      joined: () => {},
      peers: () => {},
      presence: () => {},
      presenter: () => {},
      rejected: () => {},
      unconfirmed: () => {},
      tooLarge: () => {},
    },
    clock,
  );
  const link = loopbackPair();
  host.attach(link.a, { role: 'editor' });
  collaborator.connect(link.b);
  const settle = () => {
    for (let i = 0; i < 50 && link.pump() > 0; i += 1);
  };
  settle();
  /** What the collaborator has sent the owner, in patches, so far. */
  const patchBytes = () => link.sent.b.filter((text) => text.startsWith('{"t":"patch"')).reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0);
  return { host, owner, collaborator, guest, settle, patchBytes, patches: () => link.sent.b.filter((text) => text.startsWith('{"t":"patch"')).length };
}

/** The bridge's gesture timer: a flush at most every 50 ms while the editor holds a gesture. */
function bridge(clock: Clock, flush: () => void): () => void {
  let timer: unknown = null;
  return () => {
    timer ??= clock.setTimeout(() => {
      timer = null;
      flush();
    }, 50);
  };
}

describe('a gesture held by a collaborator', () => {
  // Every patch of a thousand shapes is checked in full on each side: past vitest's 5 s on a slow runner.
  it('keeps them in the session when Make room pushes a thousand shapes aside, and ends where they let go', { timeout: 20_000 }, () => {
    const clock = manualClock();
    const shapes = Array.from({ length: 1000 }, (_, i) => createNode({ id: `n_${i}`, type: 'service', text: `Service number ${i}`, x: (i % 20) * 220, y: Math.floor(i / 20) * 120 }));
    let held = false;
    const { owner, collaborator, guest, settle, patchBytes, patches } = session(addNodes(createDocument('Big'), shapes), clock, () => held);
    const edited = bridge(clock, () => {
      collaborator.localChanged();
      settle();
    });

    // Make room pressed left of everything and dragged right, 3 px a frame for four seconds: every
    // frame writes the document (`canvas/useMakeRoom.ts`).
    held = true;
    const start = guest.file!;
    const before = patchBytes();
    for (let frame = 1; frame <= 4 * 60; frame += 1) {
      clock.advance(1000 / 60);
      guest.file = makeRoom(start, { axis: 'x', at: -10, delta: 3 * frame });
      edited();
    }
    const streamed = patchBytes() - before;
    const midway = owner.file.nodes.find((node) => node.id === 'n_999')!.x;
    // Let go: the gesture ends and the bridge sends what it holds.
    held = false;
    collaborator.localChanged();
    settle();
    clock.advance(1000);
    settle();

    expect(guest.ended).toBeNull();
    // Still watched as it happened, at a pace the owner takes: under the 1 MiB a second it refills.
    expect(patches()).toBeGreaterThan(5);
    expect(midway).toBeGreaterThan(start.nodes.find((node) => node.id === 'n_999')!.x);
    expect(streamed).toBeLessThan(5 * 1024 * 1024);
    // And it ends exactly where they let go, on both copies.
    expect(owner.file.nodes.find((node) => node.id === 'n_999')!.x).toBe(start.nodes.find((node) => node.id === 'n_999')!.x + 3 * 240);
    expect(sharedContent(guest.file!)).toEqual(sharedContent(owner.file));
  });

  it('sends where it ended even when the last moment of it was still waiting its turn', () => {
    const clock = manualClock();
    // A dozen snippets of code: each patch of the drag is megabytes.
    const shapes = Array.from({ length: 12 }, (_, i) => createNode({ id: `c_${i}`, type: 'code', x: i * 300, y: 0, code: `${i}`.padEnd(190_000, 'x') }));
    let held = false;
    const { owner, collaborator, guest, settle } = session(addNodes(createDocument('Heavy'), shapes), clock, () => held);

    held = true;
    const start = guest.file!;
    for (let step = 1; step <= 10; step += 1) {
      clock.advance(50);
      guest.file = makeRoom(start, { axis: 'x', at: -10, delta: 10 * step });
      collaborator.localChanged();
      settle();
    }
    // Let go with nothing else to say so: no further edit, no flush from the bridge.
    held = false;
    for (let i = 0; i < 20; i += 1) {
      clock.advance(500);
      settle();
    }

    expect(guest.ended).toBeNull();
    expect(owner.file.nodes.map((node) => node.x)).toEqual(start.nodes.map((node) => node.x + 100));
    expect(sharedContent(guest.file!)).toEqual(sharedContent(owner.file));
  });
});
