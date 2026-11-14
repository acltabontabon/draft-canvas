/**
 * Arrow-key nudges, applied at most once per animation frame.
 *
 * Every nudge is a committed edit, and every committed edit plans the whole diagram's connectors
 * again — a tenth of a second on a 200-shape diagram, most of a second on a thousand. A held arrow
 * key repeats about thirty times a second, so the presses queued behind each plan, and the page went
 * on nudging for seconds after the key was let go. Presses landing in the same frame now add up into
 * one nudge by their summed distance: the shape ends up exactly where the same presses put it, in
 * the same single undo step (`nudgeSelection` coalesces a burst), for one plan instead of several.
 *
 * Anything that is not an arrow press — an undo, a delete, a copy — calls `flush` first, so it sees
 * every nudge pressed before it, as it always did.
 */
export interface NudgeCoalescer {
  /** Adds a nudge of `(dx, dy)` to the shapes `ids`; applied on the next frame. */
  push(dx: number, dy: number, ids: readonly string[]): void;
  /** Applies what is pending now, without waiting for the frame. */
  flush(): void;
}

interface Pending {
  dx: number;
  dy: number;
  ids: readonly string[];
}

const sameIds = (a: readonly string[], b: readonly string[]) => a === b || (a.length === b.length && a.every((id, index) => id === b[index]));

/** `schedule` and `cancel` are the frame functions, injectable so a test can run frames by hand. */
export function createNudgeCoalescer(
  apply: (dx: number, dy: number, ids: readonly string[]) => void,
  schedule: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): NudgeCoalescer {
  let pending: Pending | null = null;
  let frame: number | null = null;

  const flush = () => {
    if (frame !== null) {
      cancel(frame);
      frame = null;
    }
    const waiting = pending;
    pending = null;
    if (waiting && (waiting.dx !== 0 || waiting.dy !== 0)) apply(waiting.dx, waiting.dy, waiting.ids);
  };

  return {
    push(dx, dy, ids) {
      // A different selection is a different move, and undoes separately: what was pending is
      // applied for the one it was pressed on.
      if (pending && !sameIds(pending.ids, ids)) flush();
      if (pending) {
        pending.dx += dx;
        pending.dy += dy;
      } else {
        pending = { dx, dy, ids };
      }
      if (frame === null) {
        frame = schedule(() => {
          frame = null;
          flush();
        });
      }
    },
    flush,
  };
}
