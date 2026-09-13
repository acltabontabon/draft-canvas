import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOP_HOLD_MS, useSceneClock } from '../src/ui/learn/useSceneClock';

const DURATIONS = [300, 400, 500];

function fakeReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media.includes('reduce') ? reduced : false,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const mount = () => renderHook(() => useSceneClock(DURATIONS, { current: null }));

describe('useSceneClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeReducedMotion(false);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('steps through the frames and loops, holding the last one a little longer', () => {
    const { result } = mount();
    expect(result.current.frame).toBe(0);
    expect(result.current.playing).toBe(true);

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.frame).toBe(1);
    act(() => vi.advanceTimersByTime(400));
    expect(result.current.frame).toBe(2);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.frame).toBe(2);
    act(() => vi.advanceTimersByTime(LOOP_HOLD_MS));
    expect(result.current.frame).toBe(0);
    expect(result.current.loop).toBe(1);
  });

  it('stands still while the tab is hidden, and picks up when it is back', () => {
    const { result } = mount();
    act(() => setVisibility('hidden'));
    expect(result.current.playing).toBe(false);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.frame).toBe(0);

    act(() => setVisibility('visible'));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.frame).toBe(1);
  });

  it('never plays under reduced motion — it shows the finished state and schedules nothing', () => {
    fakeReducedMotion(true);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const { result } = mount();
    expect(result.current.reduced).toBe(true);
    expect(result.current.playing).toBe(false);
    expect(result.current.frame).toBe(DURATIONS.length - 1);
    expect(spy).not.toHaveBeenCalled();

    // Stepping by hand still works, and stays where it was put.
    act(() => result.current.goTo(1));
    expect(result.current.frame).toBe(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.frame).toBe(1);
    spy.mockRestore();
  });

  it('jumping to a step holds there until play is pressed again', () => {
    const { result } = mount();
    act(() => result.current.goTo(2));
    expect(result.current.frame).toBe(2);
    expect(result.current.paused).toBe(true);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.frame).toBe(2);

    act(() => result.current.togglePaused());
    expect(result.current.playing).toBe(true);
    act(() => vi.advanceTimersByTime(500 + LOOP_HOLD_MS));
    expect(result.current.frame).toBe(0);
  });
});
