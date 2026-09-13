/** Whether the viewer asked for less motion. Guarded: `matchMedia` is missing outside a real browser. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * An animation's duration, or `0` — an instant jump — when the viewer asked for less motion. For
 * the motion CSS can't reach: camera pans and zooms, and timers that wait out an exit animation.
 */
export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
