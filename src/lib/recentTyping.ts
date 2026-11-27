import { isEditableTarget } from './isEditableTarget';

/**
 * When a key was last pressed (or an IME composed) anywhere on the page, for the one question "is
 * someone typing right now?" A field that merely holds focus — the title, an inspector input, a
 * select — isn't someone typing.
 */
let lastKeystroke = Number.NEGATIVE_INFINITY;
let watching = false;

/** How long after the last keystroke a focused field still counts as being typed in. Focus alone
 *  isn't enough: counted as busy, an idle title or inspector field held every agent change back
 *  until the person happened to click elsewhere. */
export const TYPING_IDLE_MS = 2500;

function mark(): void {
  lastKeystroke = Date.now();
}

/** Starts listening, once per page. Call it before the answer matters: keys pressed earlier are unknown. */
export function watchTyping(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('keydown', mark, true);
  window.addEventListener('compositionupdate', mark, true);
}

export function typedWithin(ms: number): boolean {
  return Date.now() - lastKeystroke < ms;
}

/** Whether someone is typing into the field that has focus: a field has it, and a key went down
 *  within `TYPING_IDLE_MS`. Both what an agent's change waits for and what holds back its open. */
export function typingInField(): boolean {
  return typeof document !== 'undefined' && isEditableTarget(document.activeElement) && typedWithin(TYPING_IDLE_MS);
}
