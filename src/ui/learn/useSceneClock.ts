import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

/**
 * The beat of a scene: which frame is showing, and whether it should move at all.
 *
 * One `setTimeout` per frame and nothing per animation frame — the motion itself is CSS transitions
 * between frames, so a playing scene costs a timer every second or so. It stands still whenever
 * nobody could be watching (scrolled out of the drawer, tab in the background) and never plays under
 * `prefers-reduced-motion`, which shows the finished state instead; the step chips still step
 * through it by hand.
 */

/** Extra hold on the last frame before looping, so the finished state gets a moment to be read. */
export const LOOP_HOLD_MS = 1400;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function reducedQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null;
}

function subscribeReduced(onChange: () => void): () => void {
  const query = reducedQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const readReduced = () => reducedQuery()?.matches ?? false;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const readPageVisible = () => document.visibilityState !== 'hidden';

export interface SceneClock {
  /** The frame to draw. */
  frame: number;
  /** Bumped each time the scene wraps around, so the stage can restart its entrance cleanly. */
  loop: number;
  playing: boolean;
  paused: boolean;
  reduced: boolean;
  togglePaused: () => void;
  /** Jumps to a frame and holds there — what a step chip does. */
  goTo: (frame: number) => void;
}

export function useSceneClock(durations: readonly number[], rootRef: RefObject<HTMLElement | null>): SceneClock {
  const last = durations.length - 1;
  const [frame, setFrame] = useState(0);
  const [loop, setLoop] = useState(0);
  const [paused, setPaused] = useState(false);
  /** Set once someone steps by hand — from then on the frame shown is theirs, reduced motion or not. */
  const [manual, setManual] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const pageVisible = useSyncExternalStore(subscribeVisibility, readPageVisible, () => true);
  const reduced = useSyncExternalStore(subscribeReduced, readReduced, () => false);

  useEffect(() => {
    const root = rootRef.current;
    // No observer (jsdom, very old engines): assume it's being looked at.
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? true), { threshold: 0.15 });
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef]);

  const playing = last > 0 && onScreen && pageVisible && !paused && !reduced;
  const shown = reduced && !manual ? last : frame;

  useEffect(() => {
    if (!playing) return;
    const hold = (durations[frame] ?? 1000) + (frame === last ? LOOP_HOLD_MS : 0);
    const timer = setTimeout(() => {
      if (frame >= last) {
        setFrame(0);
        setLoop((count) => count + 1);
      } else {
        setFrame(frame + 1);
      }
    }, hold);
    return () => clearTimeout(timer);
  }, [playing, frame, last, durations]);

  const goTo = useCallback(
    (next: number) => {
      setFrame(Math.max(0, Math.min(last, next)));
      setManual(true);
      setPaused(true);
    },
    [last],
  );

  const togglePaused = useCallback(() => {
    setPaused((was) => !was);
    setManual(true);
  }, []);

  return { frame: shown, loop, playing, paused: paused || reduced, reduced, togglePaused, goTo };
}
