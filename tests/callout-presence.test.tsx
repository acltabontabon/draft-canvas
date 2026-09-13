import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalloutPresence } from '../src/canvas/presentation/useCalloutPresence';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../src/lib/motion', () => ({ prefersReducedMotion: () => motion.reduced, motionMs: (ms: number) => ms }));

const subject = (key: string) => ({ key });

describe('useCalloutPresence', () => {
  beforeEach(() => {
    motion.reduced = false;
  });

  it('keeps the previous callout leaving until its animation settles', () => {
    const { result, rerender } = renderHook(({ current }) => useCalloutPresence(current), {
      initialProps: { current: subject('step-4') as { key: string } | null },
    });
    expect(result.current.leaving).toBeNull();

    rerender({ current: null });
    expect(result.current.current).toBeNull();
    expect(result.current.leaving?.key).toBe('step-4');

    act(() => result.current.settle('step-4'));
    expect(result.current.leaving).toBeNull();
  });

  it('converges on the step landed on — never more than one leaving, never a queue', () => {
    const { result, rerender } = renderHook(({ current }) => useCalloutPresence(current), {
      initialProps: { current: subject('step-1') as { key: string } | null },
    });
    rerender({ current: subject('step-4') });
    expect(result.current.leaving?.key).toBe('step-1');
    rerender({ current: null });
    expect(result.current.leaving?.key).toBe('step-4');
    rerender({ current: subject('step-6') });
    // The silent step had nothing to hand on, so step 4's fade is simply dropped.
    expect(result.current.leaving).toBeNull();
    expect(result.current.current?.key).toBe('step-6');
    // A stale settle for a callout already gone changes nothing.
    act(() => result.current.settle('step-4'));
    expect(result.current.current?.key).toBe('step-6');
  });

  it('keeps nothing leaving under reduced motion', () => {
    motion.reduced = true;
    const { result, rerender } = renderHook(({ current }) => useCalloutPresence(current), {
      initialProps: { current: subject('step-4') as { key: string } | null },
    });
    rerender({ current: subject('step-6') });
    expect(result.current.leaving).toBeNull();
  });

  it('does not treat new content under the same key as a new callout', () => {
    const { result, rerender } = renderHook(({ current }) => useCalloutPresence(current), {
      initialProps: { current: { key: 'step-4', text: 'a' } },
    });
    rerender({ current: { key: 'step-4', text: 'b' } });
    expect(result.current.leaving).toBeNull();
    expect(result.current.current?.text).toBe('b');
  });
});
