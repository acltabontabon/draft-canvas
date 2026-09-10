/**
 * What a note's text looks like once the user is done typing it.
 *
 * A note is plain multiline text, and the canvas lays it out itself (`render/text/layout.ts`),
 * so a few things a textarea happily accepts have no good rendering: Windows line endings from a
 * paste, tabs (an SVG `<text>` draws one as a single space), and the trailing blank lines left
 * behind by an Enter that never got a next line. Normalizing at commit keeps the document clean
 * without ever touching what the user is mid-way through typing.
 */
export function normalizeNoteText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/ +$/gm, '')
    .replace(/\s+$/, '');
  return text.trim() === '' ? '' : text;
}
