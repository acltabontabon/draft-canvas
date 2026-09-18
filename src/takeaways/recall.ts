/**
 * What a canvas is still owed, said once, on the way in.
 *
 * The status bar's `□ 3` is the resting state of this feature, and it is deliberately ignorable —
 * which makes it the wrong thing to rely on when a diagram is opened a week after the meeting that
 * produced it. This is the arrival state of the same mark: the count expanded into the actual
 * words for a few seconds, then settling back into the chip it came from.
 *
 * Pure, like the rest of `takeaways/`. The rule for *whether* to say anything lives here rather
 * than in the component so it can be read as a truth table — there are five ways to be wrong about
 * this and only one of them is visible in a browser.
 */

import type { Takeaways, TakeawayAction } from './collect';

/** How many actions the card shows before it stops listing and starts counting. */
export const RECALL_LIMIT = 3;

/**
 * How long the card stays before it settles back into the chip.
 *
 * The same 6s an actioned toast gets (`uiStore.ts`): long enough to read a line and decide to
 * reach for it, short enough that it is gone before it is in the way. Paused while the pointer or
 * focus is on it — see `RECALL_FLOOR_MS`.
 */
export const RECALL_MS = 6000;

/**
 * What is left on the clock after the pointer leaves, at minimum. Without a floor the card is
 * snatched away the instant you stop reading it, which reads as a glitch rather than a timeout.
 * The toasts strike the same bargain, with the same number.
 */
export const RECALL_FLOOR_MS = 1500;

export interface RecallSource {
  /**
   * Whether this open is the *same* canvas arriving again — VS Code reloading the file after an
   * outside edit, or taking another tab's copy. Not a revisit, so not a moment to be reminded:
   * nothing about the situation changed for the person watching.
   */
  reopening: boolean;
  /** Presentation carries the story; a list of chores over the top of it is what present mode is for not having. */
  presenting: boolean;
  /** The panel is already up, so the card would be the same information twice, one inch apart. */
  alreadyOpen: boolean;
  /** Open (unticked) actions in the file. Decisions and questions never bring the card back. */
  openCount: number;
}

/**
 * Whether opening this document should say anything at all.
 *
 * Every clause is a "no". The card appears only when a canvas that was not already being looked
 * at turns out to owe something.
 */
export function shouldRecall(source: RecallSource): boolean {
  if (source.openCount <= 0) return false;
  if (source.reopening) return false;
  if (source.presenting) return false;
  if (source.alreadyOpen) return false;
  return true;
}

export interface RecallContents {
  /** The rows to draw, oldest capture first — the order they were said in. */
  shown: TakeawayAction[];
  /** How many open actions did not fit. `0` when they all did. */
  overflow: number;
  /** Every open action, which is what the header counts. */
  total: number;
}

/** The open actions, capped for display. Done ones are not "still open" and never appear. */
export function recallItems(takeaways: Takeaways, limit: number = RECALL_LIMIT): RecallContents {
  const open = takeaways.actions.filter((entry) => !entry.action.done);
  return {
    shown: open.slice(0, limit),
    overflow: Math.max(0, open.length - limit),
    total: open.length,
  };
}
