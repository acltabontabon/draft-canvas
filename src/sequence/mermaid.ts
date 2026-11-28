/**
 * How text is written safely into Mermaid `sequenceDiagram` source: the keyword a participant is
 * declared with, and the escaping names, messages and notes need. `native/mermaid.ts`, which writes a
 * native sequence as the text an agent reads and edits, is its one consumer.
 */
import type { ParticipantKind } from './types';
import { noteLines } from './wrap';

export function mermaidKeyword(kind: ParticipantKind): 'actor' | 'participant' {
  return kind === 'actor' ? 'actor' : 'participant';
}

/** Everything after `as` is the display name, verbatim to the end of the line — colons, quotes and
 *  backslashes included (checked against Mermaid 11). Quoting it would put the quotes on screen; only
 *  the statement-level characters `escapeMermaidText` handles, and line breaks, need care. */
export function sanitizeParticipantName(label: string): string {
  return escapeMermaidText(label.replace(/\r\n?|\n/g, ' ').trim()) || 'Participant';
}

/** Mermaid ends a statement at `;` and starts a comment at `#`, anywhere on the line — including
 *  inside label and note text, where neither has an escape of its own — and runs rendered text
 *  through an HTML sanitizer that strips anything tag-shaped (`Map<String, Order>` would render as
 *  "Map"). `%%{ … }%%` is a directive Mermaid lifts out of the text *before* parsing, wherever it
 *  sits — a label saying `100%%{init: {"theme": …}}%%` would reconfigure the renderer — so `%` is
 *  written as its entity too. Entity codes are resolved after parsing, so each survives to render
 *  as the literal character. One pass, so the `#`/`;` an entity code itself introduces is never
 *  re-escaped. */
const MERMAID_ENTITY: Record<string, string> = { '#': '#35;', ';': '#59;', '%': '#37;', '<': '#lt;', '>': '#gt;', '&': '#amp;' };

/** Mermaid reads a leading `wrap:` or `nowrap:` (after an optional colon) on a message, note, name,
 *  condition or box as a wrapping switch and drops it from the words; its first letter as an entity
 *  code keeps them words. */
const WRAP_SWITCH = /^(\s*)(:?(?:no)?wrap:)/i;

export function escapeMermaidText(text: string): string {
  return text
    .replace(/[#;%<>&]/g, (ch) => MERMAID_ENTITY[ch]!)
    .replace(WRAP_SWITCH, (_whole, space: string, word: string) => `${space}#${word.codePointAt(0)};${word.slice(1)}`);
}

/** A message's label runs from the first `:` after the arrow to the end of the line, and a colon
 *  inside it is just text — `GET /orders: by id` is what the author wrote (checked against Mermaid
 *  11's grammar, which splits on the first colon only). Only line breaks need collapsing. Blank is
 *  blank: Mermaid reads `B-->>A:` as a message with no words, which is what a reply often is. */
export function messageText(label: string): string {
  return escapeMermaidText(label.replace(/\r\n?|\n/g, ' ').trim());
}

/**
 * A note's text, collapsed to Mermaid's single line — the format has no multi-line block form.
 * Prose is wrapped first (`noteLines`, on
 * the raw text, so entity escaping below can't skew the measured width; code keeps its lines), `&`/`<`/`>` (and the
 * statement-breaking `#`/`;`) are then written as Mermaid entity codes (so literal code containing
 * `<div>`, `&&` or `retry();` can't be misread by the parser or its HTML-ish note renderer — plain
 * HTML entities would themselves end the statement at their `;`), and the lines are joined with a
 * literal `<br/>` — Mermaid's own documented line-break token inside note text, not a hack. A colon
 * is kept: `Note over A: text` splits on its first colon only, so the ones in the text are text.
 */
export function noteText(text: string, code = false): string {
  return noteLines(text, code)
    .map((line) => escapeMermaidText(line.trim()))
    .filter((line) => line.length > 0)
    .join('<br/>');
}

/** A note that must say something: a reference Mermaid cannot write, kept as a note; a sequence's own note may be left blank (`noteText`). */
export function sanitizeNoteText(text: string, code = false): string {
  return noteText(text, code) || 'Note';
}
