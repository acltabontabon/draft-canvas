/**
 * Whether opening a canvas should point out that it still owes something.
 *
 * The status bar's `□ 3` is this feature at rest, and it is deliberately ignorable — which makes
 * it the wrong thing to rely on when a diagram is opened a week after the meeting that produced
 * it. So on arrival a small nudge points at that chip for a few seconds and says what the number
 * means, then folds into it (`StatusBar.tsx`). It explains the chip rather than standing in for
 * it: a panel that listed the actions would be the thing you are meant to click, doing the job of
 * the thing you are meant to learn.
 *
 * Pure, like the rest of `takeaways/`. The rule lives here rather than in the component so it can
 * be read as a truth table — there are four ways to be wrong about it and only one of them is
 * visible in a browser.
 */

/**
 * How long the nudge stays before it folds into the chip.
 *
 * The same 6s an actioned toast gets (`uiStore.ts`): long enough to read a line and decide to
 * reach for it, short enough that it is gone before it is in the way. Paused while the pointer or
 * focus is on it — see `RECALL_FLOOR_MS`.
 */
export const RECALL_MS = 6000;

/**
 * What is left on the clock after the pointer leaves, at minimum. Without a floor the nudge is
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
  /** Presentation carries the story, and there is no status bar to point at while it does. */
  presenting: boolean;
  /** Takeaways is already open, so pointing at the way to open it would be a beat behind. */
  alreadyOpen: boolean;
  /** Open (unticked) actions in the file. Decisions and questions never bring the nudge back. */
  openCount: number;
}

/**
 * Whether opening this document should say anything at all.
 *
 * Every clause is a "no". The nudge appears only when a canvas that was not already being looked
 * at turns out to owe something.
 */
export function shouldRecall(source: RecallSource): boolean {
  if (source.openCount <= 0) return false;
  if (source.reopening) return false;
  if (source.presenting) return false;
  if (source.alreadyOpen) return false;
  return true;
}
