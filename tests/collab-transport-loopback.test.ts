import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_BYTES } from '../src/collab/transport/chunk';
import { createLoopbackPair, seededRandom, type LoopbackFaults } from '../src/collab/transport/loopback';
import type { CollabTransport, TransportState } from '../src/collab/transport/types';

function inbox(transport: CollabTransport): string[] {
  const received: string[] = [];
  transport.onMessage((message) => received.push(message));
  return received;
}

function states(transport: CollabTransport): [TransportState, string | undefined][] {
  const seen: [TransportState, string | undefined][] = [];
  transport.onState((state, reason) => seen.push([state, reason]));
  return seen;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('loopback transport', () => {
  it('delivers whole messages both ways, asynchronously and in order', async () => {
    const { a, b } = createLoopbackPair();
    expect([a.kind, a.state, b.state]).toEqual(['loopback', 'open', 'open']);
    const atA = inbox(a);
    const atB = inbox(b);
    expect(a.send('1', 'commit')).toBe(true);
    expect(a.send('2', 'presence')).toBe(true);
    b.send('back', 'commit');
    expect(atB).toEqual([]);
    await settle();
    expect(atB).toEqual(['1', '2']);
    expect(atA).toEqual(['back']);
  });

  it('stops delivering to a listener once it unsubscribes', async () => {
    const { a, b } = createLoopbackPair();
    const received: string[] = [];
    const stop = b.onMessage((message) => received.push(message));
    a.send('first', 'commit');
    await settle();
    stop();
    a.send('second', 'commit');
    await settle();
    expect(received).toEqual(['first']);
  });

  it('closes both ends, telling the other side its peer left', async () => {
    const { a, b } = createLoopbackPair();
    const atA = states(a);
    const atB = states(b);
    const received = inbox(b);
    a.send('in flight', 'commit');
    a.close('done');
    a.close('again');
    await settle();
    expect(atA).toEqual([['closed', 'done']]);
    expect(atB).toEqual([['closed', 'peer-closed']]);
    expect(received).toEqual([]);
    expect(a.send('late', 'commit')).toBe(false);
    expect(b.send('late', 'presence')).toBe(false);
  });

  it('holds commits through an outage and refuses presence until it ends', async () => {
    const pair = createLoopbackPair();
    const atA = states(pair.a);
    const received = inbox(pair.b);
    pair.a.send('before', 'commit');
    pair.interrupt();
    expect(pair.a.state).toBe('degraded');
    expect(pair.b.state).toBe('degraded');
    expect(pair.a.send('cursor', 'presence')).toBe(false);
    expect(pair.a.send('during', 'commit')).toBe(true);
    await settle();
    expect(received).toEqual([]);
    pair.restore();
    await settle();
    expect(received).toEqual(['before', 'during']);
    expect(atA).toEqual([['degraded', 'disconnected'], ['open', undefined]]);
  });

  it('ends a timed outage on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pair = createLoopbackPair();
    const received = inbox(pair.b);
    pair.interrupt(1000);
    pair.a.send('queued', 'commit');
    await vi.advanceTimersByTimeAsync(999);
    expect(pair.a.state).toBe('degraded');
    await vi.advanceTimersByTimeAsync(1);
    expect(pair.a.state).toBe('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(['queued']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can sever the link for good', () => {
    const pair = createLoopbackPair();
    const atB = states(pair.b);
    pair.sever('network gone');
    expect(atB).toEqual([['closed', 'network gone']]);
    expect(pair.a.state).toBe('closed');
  });

  it('refuses a message larger than any transport carries', () => {
    const { a } = createLoopbackPair();
    expect(() => a.send('x'.repeat(MAX_MESSAGE_BYTES + 1), 'commit')).toThrow(RangeError);
  });
});

describe('loopback faults', () => {
  async function run(faults: LoopbackFaults, sends: number, priority: 'commit' | 'presence' = 'commit') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pair = createLoopbackPair(faults);
    const received = inbox(pair.b);
    const results: boolean[] = [];
    for (let i = 0; i < sends; i++) {
      results.push(pair.a.send(String(i), priority));
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    return { received, results, timers, pair };
  }

  it('replays the same faults from the same seed', async () => {
    const faults = { seed: 42, delayMs: [0, 20] as [number, number], drop: 0.2, duplicate: 0.2, reorder: 0.2 };
    const first = await run(faults, 60, 'presence');
    const second = await run(faults, 60, 'presence');
    const other = await run({ ...faults, seed: 43 }, 60, 'presence');
    expect(first.received).toEqual(second.received);
    expect(first.received).not.toEqual(other.received);
  });

  it('drops presence but never commits unless told to', async () => {
    const presence = await run({ seed: 7, drop: 0.5 }, 100, 'presence');
    expect(presence.received.length).toBeLessThan(80);
    expect(presence.results.filter((sent) => !sent)).toHaveLength(100 - presence.received.length);
    const commits = await run({ seed: 7, drop: 0.5 }, 100);
    expect(commits.received).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    const lossy = await run({ seed: 7, drop: 0.5, dropCommits: true }, 100);
    expect(lossy.received.length).toBeLessThan(80);
    // A lost commit was still "sent" as far as the sender can tell.
    expect(lossy.results.every(Boolean)).toBe(true);
  });

  it('duplicates messages', async () => {
    const { received } = await run({ seed: 3, duplicate: 0.3 }, 50);
    expect(received.length).toBeGreaterThan(50);
    expect(new Set(received).size).toBe(50);
  });

  it('reorders messages without losing any', async () => {
    const { received, timers } = await run({ seed: 5, reorder: 0.3 }, 50);
    expect(received).not.toEqual([...received].sort((x, y) => Number(x) - Number(y)));
    expect([...received].sort((x, y) => Number(x) - Number(y))).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
    expect(timers).toBe(0);
  });

  it('keeps jittered delivery in order', async () => {
    const { received } = await run({ seed: 9, delayMs: [0, 500] }, 40);
    expect(received).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
  });

  it('drops the link at random and recovers after the outage, with every commit delivered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pair = createLoopbackPair({ seed: 11, disconnect: 0.1, outageMs: 50 });
    const seen = states(pair.a);
    const received = inbox(pair.b);
    for (let i = 0; i < 100; i++) {
      pair.a.send(String(i), 'commit');
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.filter(([state]) => state === 'degraded').length).toBeGreaterThan(1);
    expect(pair.a.state).toBe('open');
    expect(received).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  });

  it('closes both ends when a random disconnect has no outage length', async () => {
    const { pair, results } = await run({ seed: 2, disconnect: 0.2 }, 30);
    expect(pair.a.state).toBe('closed');
    expect(pair.b.state).toBe('closed');
    expect(results.at(-1)).toBe(false);
  });

  it('draws from a deterministic generator', () => {
    const first = seededRandom(1);
    const second = seededRandom(1);
    const values = Array.from({ length: 5 }, () => first());
    expect(values).toEqual(Array.from({ length: 5 }, () => second()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
