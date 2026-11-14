/**
 * Holding Alt (Option) while dragging or resizing turns alignment snapping off, so a shape can be
 * put exactly where the pointer is — a few pixels from a neighbour, say, which the snap would
 * otherwise pull it into line with. Alt is free during every drag gesture here: it only appears in
 * the keyboard's own navigation chords (Alt+arrow).
 *
 * React Flow's change events carry no modifier state, so it is tracked from the window instead:
 * the pointer's own `altKey` on every move and press (the frame's pointer event always runs before
 * React Flow's own handling of it), and the key's own events so that pressing it while holding the
 * pointer still takes hold on the next move. A window that loses focus forgets it: a key released
 * somewhere else never arrives.
 */
let held = false;

/** Whether snapping is switched off at this moment. */
export function snapBypassed(): boolean {
  return held;
}

/** Starts following the modifier; the returned function stops it. Safe to call more than once. */
export function trackSnapBypass(target: Window = window): () => void {
  const read = (event: KeyboardEvent | PointerEvent) => {
    held = event.altKey;
  };
  const reset = () => {
    held = false;
  };
  const options = { capture: true, passive: true } as const;
  target.addEventListener('pointermove', read, options);
  target.addEventListener('pointerdown', read, options);
  target.addEventListener('keydown', read, options);
  target.addEventListener('keyup', read, options);
  target.addEventListener('blur', reset);
  return () => {
    target.removeEventListener('pointermove', read, options);
    target.removeEventListener('pointerdown', read, options);
    target.removeEventListener('keydown', read, options);
    target.removeEventListener('keyup', read, options);
    target.removeEventListener('blur', reset);
    held = false;
  };
}
