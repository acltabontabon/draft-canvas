/**
 * When a key was last pressed (or an IME composed) anywhere on the page, for the one question "is
 * someone typing right now?" A field that merely holds focus — the title, an inspector input, a
 * select — isn't someone typing.
 */
let lastKeystroke = Number.NEGATIVE_INFINITY;
let watching = false;

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
