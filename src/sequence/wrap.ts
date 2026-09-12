/**
 * Note text is wrapped before it reaches either emitter, because neither target format does it for
 * us: PlantUML and Mermaid both render a note as exactly the lines they are given, so one long
 * sentence becomes one very wide box that stretches the whole diagram sideways.
 *
 * Author-written line breaks are intent and are always kept; wrapping only ever adds breaks inside
 * a line that is too long on its own.
 */

/** Chosen to keep a note roughly as wide as a couple of participant boxes — wide enough to read as
 *  prose, narrow enough that a note never sets the width of the whole diagram. */
export const NOTE_WRAP_WIDTH = 60;

/**
 * Splits `text` into display lines no longer than `width` where it can. Words are never broken
 * mid-word, so a single over-long token (a URL, an identifier) keeps its own line and overflows
 * rather than being silently mangled.
 */
export function wrapNoteLines(text: string, width: number = NOTE_WRAP_WIDTH): string[] {
  const wrapped: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      wrapped.push('');
      continue;
    }

    let current = '';
    for (const word of line.split(/\s+/)) {
      if (current === '') current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        wrapped.push(current);
        current = word;
      }
    }
    wrapped.push(current);
  }

  return wrapped;
}
