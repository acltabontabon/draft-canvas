import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerView, Presence } from '../../src/collab/protocol';
import { COLLAB_AT_REST, useCollabStore } from '../../src/store/collabStore';
import { decodeFollowViewport, encodeFollowViewport, followMotion, roomRoute } from '../../src/ui/collab/presence/follow';
import {
  MAX_SHARED_SELECTION,
  holdingsOf,
  peersInRoom,
  presenceOf,
  presenterOf,
  roomOf,
  sameFollow,
  samePresence,
} from '../../src/ui/collab/presence/model';
import { createThrottle, type Clock } from '../../src/ui/collab/presence/throttle';
import { shouldFollow, stopFollowingOnGesture } from '../../src/ui/collab/presence/useFollowPresenter';

/** A clock the test moves by hand: `advance` runs whatever timers fall due, in order. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let next = 1;
  const clock: Clock = {
    now: () => now,
    set: (run, ms) => {
      const id = next++;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clear: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = until;
  };
  return { clock, advance, pending: () => timers.length };
}

const presence = (overrides: Partial<Presence> = {}): Presence => ({
  room: '',
  pointer: { x: 0, y: 0 },
  selection: { nodes: [], edges: [] },
  editing: null,
  ...overrides,
});

const peer = (id: string, overrides: Partial<PeerView> = {}): PeerView => ({
  id,
  name: id.toUpperCase(),
  color: 1,
  role: 'editor',
  link: 'live',
  ...overrides,
});

describe('presence throttle', () => {
  it('sends the first value at once, then at most one per interval, ending on the latest', () => {
    const { clock, advance } = fakeClock();
    const sent: number[] = [];
    const throttle = createThrottle<number>((value) => sent.push(value), (a, b) => a === b, 50, clock);

    throttle.push(1);
    expect(sent).toEqual([1]);
    advance(10);
    throttle.push(2);
    advance(10);
    throttle.push(3);
    expect(sent).toEqual([1]);
    // The trailing send carries the latest value, not the first one that waited.
    advance(30);
    expect(sent).toEqual([1, 3]);
    advance(200);
    expect(sent).toEqual([1, 3]);
  });

  it('caps a continuous stream at one message per interval', () => {
    const { clock, advance } = fakeClock();
    const sent: number[] = [];
    const throttle = createThrottle<number>((value) => sent.push(value), (a, b) => a === b, 50, clock);
    // A pointer reporting every 4 ms for one second.
    for (let t = 0; t < 1000; t += 4) {
      throttle.push(t);
      advance(4);
    }
    advance(100);
    expect(sent.length).toBeLessThanOrEqual(21);
    expect(sent.length).toBeGreaterThanOrEqual(19);
    expect(sent.at(-1)).toBe(996);
  });

  it('sends nothing for an unchanged value, or one that changed and changed back while it waited', () => {
    const { clock, advance } = fakeClock();
    const sent: Presence[] = [];
    const throttle = createThrottle<Presence>((value) => sent.push(value), samePresence, 50, clock);
    throttle.push(presence());
    throttle.push(presence());
    advance(100);
    throttle.push(presence());
    expect(sent).toHaveLength(1);

    throttle.push(presence({ pointer: { x: 5, y: 5 } }));
    expect(sent).toHaveLength(2);
    throttle.push(presence({ pointer: { x: 9, y: 9 } }));
    throttle.push(presence({ pointer: { x: 5, y: 5 } }));
    advance(100);
    expect(sent).toHaveLength(2);
  });

  it('drops a waiting value on cancel, and resends after reset', () => {
    const { clock, advance, pending } = fakeClock();
    const sent: number[] = [];
    const throttle = createThrottle<number>((value) => sent.push(value), (a, b) => a === b, 50, clock);
    throttle.push(1);
    throttle.push(2);
    expect(pending()).toBe(1);
    throttle.cancel();
    expect(pending()).toBe(0);
    advance(100);
    expect(sent).toEqual([1]);
    throttle.reset();
    throttle.push(1);
    expect(sent).toEqual([1, 1]);
  });
});

describe('presence value', () => {
  it('names the room by its owner, the document by an empty string', () => {
    expect(roomOf([])).toBe('');
    expect(roomOf(['a', 'b'])).toBe('b');
  });

  it('rounds the pointer and sends an oversized selection as none', () => {
    const many = Array.from({ length: MAX_SHARED_SELECTION + 1 }, (_, i) => `n${i}`);
    const value = presenceOf({
      path: ['outer'],
      pointer: { x: 10.04, y: -3.96 },
      selection: { nodes: many, edges: ['e1'] },
      editing: 'n1',
    });
    expect(value).toEqual({ room: 'outer', pointer: { x: 10, y: -4 }, selection: { nodes: [], edges: ['e1'] }, editing: 'n1' });
    // Sub-pixel jitter is no move.
    const jitter = presenceOf({ path: ['outer'], pointer: { x: 10.01, y: -4.02 }, selection: { nodes: [], edges: ['e1'] }, editing: 'n1' });
    expect(samePresence(value, jitter)).toBe(true);
  });

  it('tells a changed selection, room or editor apart', () => {
    const base = presence({ selection: { nodes: ['a'], edges: [] } });
    expect(samePresence(base, presence({ selection: { nodes: ['b'], edges: [] } }))).toBe(false);
    expect(samePresence(base, { ...base, room: 'x' })).toBe(false);
    expect(samePresence(base, { ...base, editing: 'a' })).toBe(false);
    expect(samePresence(base, { ...base, pointer: null })).toBe(false);
  });
});

describe('who is drawn on this canvas', () => {
  it('shows only people in the room on screen, and nobody who has gone', () => {
    const peers = [peer('a'), peer('b'), peer('c', { link: 'gone' }), peer('d', { link: 'reconnecting', color: 11 })];
    const where = {
      a: presence(),
      b: presence({ room: 'inner' }),
      c: presence(),
      d: presence(),
    };
    const atRoot = peersInRoom(peers, where, '');
    expect(atRoot.map((p) => p.id)).toEqual(['a', 'd']);
    expect(atRoot[1]).toMatchObject({ faint: true, color: 3 });
    expect(peersInRoom(peers, where, 'inner').map((p) => p.id)).toEqual(['b']);
  });

  it('ignores presence for someone not in the session, whatever their id', () => {
    const where = { ['__proto__']: presence(), ghost: presence() } as Record<string, Presence>;
    expect(peersInRoom([peer('a')], where, '')).toEqual([]);
  });

  it('counts typing in a shape as holding it', () => {
    const shown = peersInRoom(
      [peer('a'), peer('b', { color: 2 })],
      { a: presence({ selection: { nodes: ['n1'], edges: ['e1'] } }), b: presence({ editing: 'n2', selection: { nodes: ['n1'], edges: [] } }) },
      '',
    );
    const holdings = holdingsOf(shown);
    expect(holdings.nodes.get('n1')?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(holdings.nodes.get('n2')?.map((p) => p.id)).toEqual(['b']);
    expect(holdings.edges.get('e1')?.map((p) => p.id)).toEqual(['a']);
    expect(holdings.editing.get('n2')?.id).toBe('b');
  });

  it('knows the presenter as the session owner', () => {
    expect(presenterOf([peer('a'), peer('host', { role: 'owner' })])?.id).toBe('host');
  });
});

describe('following the presenter', () => {
  it('lands the presenter’s subject in the middle of any window, at their zoom', () => {
    const presenter = { x: 100, y: -40, zoom: 1.5 };
    const shared = encodeFollowViewport(presenter, { width: 1600, height: 1000 });
    const follower = decodeFollowViewport(shared, { width: 800, height: 600 });
    // The flow point at the centre of the presenter's view…
    const centre = { x: (800 - presenter.x) / presenter.zoom, y: (500 - presenter.y) / presenter.zoom };
    // …is at the centre of the follower's.
    expect(centre.x * follower.zoom + follower.x).toBeCloseTo(400);
    expect(centre.y * follower.zoom + follower.y).toBeCloseTo(300);
    expect(follower.zoom).toBe(1.5);
    expect(decodeFollowViewport(shared, { width: 1600, height: 1000 })).toEqual(presenter);
  });

  it('glides for small moves, flies for jumps, and stays put when already there', () => {
    const view = { width: 1000, height: 800 };
    const camera = { x: 0, y: 0, zoom: 1 };
    expect(followMotion(camera, { x: 0.2, y: 0, zoom: 1 }, view)).toBeNull();
    expect(followMotion(camera, { x: 40, y: 10, zoom: 1.1 }, view)).toMatchObject({ interpolate: 'linear', easeOut: true });
    expect(followMotion(camera, { x: 2000, y: 0, zoom: 1 }, view)).toMatchObject({ interpolate: 'smooth' });
    expect(followMotion(camera, { x: 0, y: 0, zoom: 2 }, view)).toMatchObject({ interpolate: 'smooth' });
  });

  it('walks between rooms through the depth they share', () => {
    expect(roomRoute([], ['a', 'b'])).toEqual({ exitTo: null, enter: ['a', 'b'] });
    expect(roomRoute(['a', 'b'], [])).toEqual({ exitTo: 0, enter: [] });
    expect(roomRoute(['a', 'b'], ['a', 'c'])).toEqual({ exitTo: 1, enter: ['c'] });
    expect(roomRoute(['a'], ['a'])).toEqual({ exitTo: null, enter: [] });
  });

  it('compares presenter states by value', () => {
    const state = { path: ['a'], viewport: { x: 1, y: 2, zoom: 1 }, presenting: true, flowId: 'f', step: 0 };
    expect(sameFollow(state, { ...state, path: ['a'] })).toBe(true);
    expect(sameFollow(state, { ...state, step: 1 })).toBe(false);
    expect(sameFollow(state, null)).toBe(false);
  });
});

describe('follow on and off', () => {
  afterEach(() => useCollabStore.setState(COLLAB_AT_REST, true));

  const presenting = { path: [], viewport: { x: 0, y: 0, zoom: 1 }, presenting: true, flowId: null, step: null };

  it('follows only while someone presents, it is asked for, and this person is not presenting', () => {
    expect(shouldFollow({ presenter: presenting, following: true }, 'edit')).toBe(true);
    expect(shouldFollow({ presenter: presenting, following: false }, 'edit')).toBe(false);
    expect(shouldFollow({ presenter: null, following: true }, 'edit')).toBe(false);
    expect(shouldFollow({ presenter: presenting, following: true }, 'present')).toBe(false);
  });

  it('lets go when the collaborator moves the camera themselves, never for the app’s own moves', () => {
    useCollabStore.setState({ role: 'guest', status: 'live', presenter: presenting, following: true });
    stopFollowingOnGesture(null);
    expect(useCollabStore.getState().following).toBe(true);
    stopFollowingOnGesture(new Event('wheel'));
    expect(useCollabStore.getState().following).toBe(false);
  });

  it('leaves the owner’s own state alone', () => {
    const set = vi.spyOn(useCollabStore, 'setState');
    useCollabStore.setState({ role: 'host', status: 'live' });
    set.mockClear();
    stopFollowingOnGesture(new Event('wheel'));
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });
});

describe('following on a smaller screen', () => {
  it('zooms out to show all of the presenter’s view, and never zooms in on a bigger one', async () => {
    const { decodeFollowViewport, encodeFollowViewport } = await import('../../src/ui/collab/presence/follow');
    const presenter = { width: 1600, height: 900 };
    const shared = encodeFollowViewport({ x: 100, y: 50, zoom: 1 }, presenter);
    const small = decodeFollowViewport(shared, { width: 800, height: 600 }, presenter);
    expect(small.zoom).toBeCloseTo(0.5);
    const big = decodeFollowViewport(shared, { width: 2400, height: 1400 }, presenter);
    expect(big.zoom).toBe(1);
    // Same screen: exactly the presenter's camera.
    expect(decodeFollowViewport(shared, presenter, presenter)).toEqual({ x: 100, y: 50, zoom: 1 });
  });
});
