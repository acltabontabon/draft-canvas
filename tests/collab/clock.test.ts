import { describe, expect, it, vi } from 'vitest';
import { ByteBudget, RateLimit, REAL_CLOCK, type Clock } from '../../src/collab/clock';
import { GuestSession } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { createDocument } from '../../src/document/factory';
import { setTitle } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair } from './support';

/**
 * Time as the session engines see it. Timers run on monotonic time, as a browser's do, while a
 * machine's wall clock can be stepped back or forward at any moment — by time sync, a VM resuming,
 * or by hand. Neither the budgets nor the session may read that as anything a peer did.
 */

/** Timers on a monotonic count; `now()` on a wall clock that can be stepped by `offset`. */
function steppedClock(): Clock & { advance(ms: number): void; step(ms: number): void } {
  let mono = 0;
  let offset = 1_700_000_000_000;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => mono + offset,
    setTimeout(run, ms) {
      const id = next++;
      timers.set(id, { at: mono + ms, run });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const until = mono + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        mono = due[1].at;
        due[1].run();
      }
      mono = until;
    },
    step(ms) {
      offset += ms;
    },
  };
}

describe('the budgets, when the clock steps back', () => {
  it('still let a message through: a refill is never negative', () => {
    const clock = steppedClock();
    const messages = new RateLimit(clock, 60, 240);
    const bytes = new ByteBudget(clock, 1024 * 1024, 8 * 1024 * 1024);
    expect(messages.take()).toBe(true);
    expect(bytes.spend(1024)).toBe(true);
    // A minute back: the refill came to minus a minute's worth, and emptied both buckets.
    clock.step(-60_000);
    expect(messages.take()).toBe(true);
    expect(bytes.spend(1024)).toBe(true);
    // And they keep refilling from there as time goes on.
    for (let i = 0; i < 1000; i += 1) messages.take();
    clock.advance(1000);
    expect(messages.take()).toBe(true);
  });
});

describe('a session, when the owner’s clock steps back', () => {
  it('keeps a collaborator who is typing, and takes their edits', () => {
    const owner = steppedClock();
    const theirs = steppedClock();
    const hostState = { file: createDocument('Clock') as DraftDocument };
    const host = new HostSession(
      { readFile: () => hostState.file, applyRemote: (file) => ((hostState.file = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
      owner,
    );
    const state = { file: null as DraftDocument | null, ended: null as string | null };
    const guest = new GuestSession(
      {
        readFile: () => state.file!,
        applyRemote: (file) => ((state.file = file), true),
        isBusy: () => state.file === null,
        open: (file) => (state.file = file),
        setAccess: () => {},
        appVersion: PRODUCT.version,
        name: 'Grace',
      },
      {
        status: (status, reason) => {
          if (status === 'ended') state.ended = reason ?? 'ended';
        },
        joined: () => {},
        peers: () => {},
        presence: () => {},
        presenter: () => {},
        rejected: () => {},
        unconfirmed: () => {},
        tooLarge: () => {},
      },
      theirs,
    );
    const { a, b, pump } = loopbackPair();
    host.attach(a, { role: 'editor' });
    guest.connect(b);
    pump();
    pump();
    const tick = (title: string) => {
      owner.advance(1000);
      theirs.advance(1000);
      pump();
      state.file = setTitle(state.file!, title);
      guest.localChanged();
      pump();
    };
    for (let i = 0; i < 60; i += 1) tick(`Typing ${i}`);
    owner.step(-6_000);
    tick('After the step');

    expect(state.ended).toBeNull();
    expect(host.peers()).toHaveLength(2);
    expect(hostState.file.metadata.title).toBe('After the step');
  });
});

describe('the clock the app runs on', () => {
  it('measures time on the monotonic clock, so stepping the wall clock moves no interval', () => {
    const before = REAL_CLOCK.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000);
    try {
      expect(REAL_CLOCK.now()).toBeGreaterThanOrEqual(before);
    } finally {
      now.mockRestore();
    }
  });
});
