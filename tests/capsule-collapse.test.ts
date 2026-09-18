import { describe, expect, it } from 'vitest';
import {
  CAPSULE_MIN_COLLAPSED_MS,
  CAPSULE_RELEASE_MARGIN_PX,
  EXPANDED,
  expandRect,
  nextCapsuleState,
} from '../src/canvas/capsuleCollapse';

const inside = { inside: true, near: true };
const near = { inside: false, near: true };
const clear = { inside: false, near: false };

describe('nextCapsuleState', () => {
  it('collapses the moment the aim point reaches a target', () => {
    const next = nextCapsuleState(EXPANDED, inside, 1_000);
    expect(next.collapsed).toBe(true);
    expect(next.since).toBe(1_000);
  });

  it('stays expanded while there is nothing to attach to', () => {
    expect(nextCapsuleState(EXPANDED, clear, 1_000)).toBe(EXPANDED);
  });

  it('holds the collapse while still within the release margin', () => {
    const collapsed = nextCapsuleState(EXPANDED, inside, 0);
    expect(nextCapsuleState(collapsed, near, 5_000).collapsed).toBe(true);
  });

  it('expands once clear of the margin, but not before the minimum hold', () => {
    const collapsed = nextCapsuleState(EXPANDED, inside, 0);
    // A fast pass across a lone connector: clear again almost immediately.
    expect(nextCapsuleState(collapsed, clear, CAPSULE_MIN_COLLAPSED_MS - 1).collapsed).toBe(true);
    expect(nextCapsuleState(collapsed, clear, CAPSULE_MIN_COLLAPSED_MS).collapsed).toBe(false);
  });

  it('does not thrash when the aim point flickers on a target boundary', () => {
    let state = nextCapsuleState(EXPANDED, inside, 0);
    const seen: boolean[] = [];
    // Alternating in/out along an edge, faster than the minimum hold.
    for (let t = 10; t <= 140; t += 10) {
      state = nextCapsuleState(state, t % 20 === 0 ? clear : inside, t);
      seen.push(state.collapsed);
    }
    expect(seen.every(Boolean)).toBe(true);
  });

  it('re-collapses on a new target after expanding, with a fresh clock', () => {
    const first = nextCapsuleState(EXPANDED, inside, 0);
    const expanded = nextCapsuleState(first, clear, CAPSULE_MIN_COLLAPSED_MS);
    expect(expanded.collapsed).toBe(false);
    const second = nextCapsuleState(expanded, inside, 900);
    expect(second.collapsed).toBe(true);
    expect(second.since).toBe(900);
  });
});

describe('expandRect', () => {
  it('grows a rect by the margin on every side', () => {
    expect(expandRect({ x: 10, y: 20, width: 100, height: 40 }, CAPSULE_RELEASE_MARGIN_PX)).toEqual({
      x: 10 - CAPSULE_RELEASE_MARGIN_PX,
      y: 20 - CAPSULE_RELEASE_MARGIN_PX,
      width: 100 + CAPSULE_RELEASE_MARGIN_PX * 2,
      height: 40 + CAPSULE_RELEASE_MARGIN_PX * 2,
    });
  });
});
