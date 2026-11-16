import { describe, expect, it } from 'vitest';
import { createNudgeCoalescer } from '../src/ui/Editor/nudgeCoalescer';

/** Frames run by hand: nothing is applied until `frame()` says a frame has come. */
function frames() {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (callback: () => void) => {
      queue.set(next, callback);
      return next++;
    },
    cancel: (handle: number) => {
      queue.delete(handle);
    },
    frame: () => {
      const due = [...queue.values()];
      queue.clear();
      for (const callback of due) callback();
    },
    pending: () => queue.size,
  };
}

function make() {
  const clock = frames();
  const applied: Array<[number, number, readonly string[]]> = [];
  const nudges = createNudgeCoalescer((dx, dy, ids) => applied.push([dx, dy, ids]), clock.schedule, clock.cancel);
  return { nudges, applied, clock };
}

describe('nudge coalescing', () => {
  it('applies nothing until the frame, then one nudge for every press in it', () => {
    const { nudges, applied, clock } = make();
    nudges.push(1, 0, ['a']);
    nudges.push(1, 0, ['a']);
    nudges.push(0, 10, ['a']);
    expect(applied).toEqual([]);
    clock.frame();
    expect(applied).toEqual([[2, 10, ['a']]]);
  });

  it('asks for one frame however many presses come, so a held key queues nothing behind a stall', () => {
    const { nudges, clock } = make();
    for (let press = 0; press < 30; press += 1) nudges.push(-1, 0, ['a']);
    expect(clock.pending()).toBe(1);
  });

  it('starts over after a frame', () => {
    const { nudges, applied, clock } = make();
    nudges.push(1, 0, ['a']);
    clock.frame();
    nudges.push(0, -1, ['a']);
    clock.frame();
    expect(applied).toEqual([[1, 0, ['a']], [0, -1, ['a']]]);
  });

  it('applies what is pending at once on flush, and has nothing left for the frame', () => {
    const { nudges, applied, clock } = make();
    nudges.push(1, 0, ['a']);
    nudges.push(1, 0, ['a']);
    nudges.flush();
    expect(applied).toEqual([[2, 0, ['a']]]);
    expect(clock.pending()).toBe(0);
    clock.frame();
    expect(applied).toHaveLength(1);
  });

  it('does nothing on flush with nothing pending', () => {
    const { nudges, applied } = make();
    nudges.flush();
    expect(applied).toEqual([]);
  });

  it('does not apply presses that cancel out', () => {
    const { nudges, applied, clock } = make();
    nudges.push(1, 0, ['a']);
    nudges.push(-1, 0, ['a']);
    clock.frame();
    expect(applied).toEqual([]);
  });

  it('applies a press for another selection to that selection, separately', () => {
    const { nudges, applied, clock } = make();
    nudges.push(1, 0, ['a']);
    nudges.push(0, 1, ['b']);
    clock.frame();
    expect(applied).toEqual([[1, 0, ['a']], [0, 1, ['b']]]);
  });

  it('adds up presses on the same shapes however their ids arrive', () => {
    const { nudges, applied, clock } = make();
    nudges.push(1, 0, ['a', 'b']);
    nudges.push(1, 0, ['a', 'b']);
    clock.frame();
    expect(applied).toEqual([[2, 0, ['a', 'b']]]);
  });
});
