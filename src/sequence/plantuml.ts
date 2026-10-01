/**
 * SequenceModel → PlantUML text. A pure, independent consumer of the model — built directly from
 * `SequenceModel`, never by converting `mermaid.ts`'s output.
 */
import type { NoteKind } from '../document/types';
import type { InteractionKind, ParticipantKind, SequenceElement, SequenceModel } from './types';
import { wrapNoteLines } from './wrap';

/** PlantUML's own conventions: `->` (solid, filled arrowhead) for a synchronous call, `-->`
 *  (dashed, filled arrowhead) for a reply, `->>` (solid, open/thin arrowhead — PlantUML's
 *  documented async convention) for an asynchronous message. */
const ARROW: Record<InteractionKind, string> = {
  sync: '->',
  response: '-->',
  async: '->>',
};

const INDENT = '    ';

function plantUmlKeyword(kind: ParticipantKind): string {
  switch (kind) {
    case 'actor':
      return 'actor';
    case 'database':
      return 'database';
    case 'queue':
      return 'queue';
    default:
      return 'participant';
  }
}

/**
 * PlantUML reads markup *inside* text: Creole (`**bold**`, `--strike--`, `~~wave~~`), a subset of
 * HTML (`<b>`, `<color:red>`, `<img:file.png>` — which loads a file — and `<U+XXXX>`), preprocessor
 * calls (`%date()`, `%getenv("HOME")` — which runs), and `\n` as a line break. None of it is what a
 * label typed in the editor meant. The characters that open any of it are written as PlantUML's
 * own `<U+XXXX>` codes, which render as exactly that character and start nothing: `<` (every tag
 * and image include), `%` (every preprocessor call), `~` (Creole's escape and wave markup), `\`
 * (the `\n` break), `*`, `-` and `_` only when doubled (bold, strike, underline). Checked against
 * PlantUML 1.2025: `<U+003C>b<U+003E>` renders as `<b>`.
 */
function escapePlantUmlText(text: string): string {
  return text.replace(/<|%|~|\\|\*\*|--|__/g, (token) =>
    token.length === 2 ? `${unicodeCode(token)}${token[1]}` : unicodeCode(token),
  );
}

function unicodeCode(text: string): string {
  return `<U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** PlantUML declares a participant as `<keyword> "<display name>" as <alias>` — the quoted name
 *  may contain any character except an unescaped double quote. Newlines are collapsed since a
 *  declaration is a single line. The quote is the one character `escapePlantUmlText` leaves, and
 *  the only one the quoted form itself cares about. */
function sanitizeParticipantName(label: string): string {
  return escapePlantUmlText(label.replace(/\r\n?|\n/g, ' ')).replace(/"/g, '<U+0022>');
}

/** A PlantUML message's text runs to the end of the line, with no delimiter character of its own
 *  to guard (unlike Mermaid's `:`) — only newlines need collapsing to keep it on one line, and
 *  the markup above needs disarming. */
function sanitizeMessageLabel(label: string): string {
  const clean = escapePlantUmlText(label.replace(/\r\n?|\n/g, ' ').trim());
  return clean || 'Message';
}

/** A `group <label>` line is as unquoted and single-line as PlantUML gets — an embedded newline in
 *  a Flow's title would otherwise close the line early and let the rest be read as new PlantUML
 *  statements. */
function sanitizeGroupLabel(label: string): string {
  const clean = escapePlantUmlText(label.replace(/\r\n?|\n/g, ' ').trim());
  return clean || 'Group';
}

/** Portable, CSS-free prefixes — the source itself must carry the distinction, since a `.mmd`/
 *  `.puml` file has no access to Draft Canvas's own note-kind colors. A plain Note gets none. */
const NOTE_PREFIX: Partial<Record<NoteKind, string>> = {
  question: 'Question: ',
  warning: 'Warning: ',
  decision: 'Decision: ',
};

/**
 * PlantUML's real multi-line note block, used for every annotation — one code path, never
 * switching on content length the way Mermaid has to. The text is wrapped (`wrapNoteLines`) so a
 * long sentence doesn't stretch the note box across the whole diagram, and each resulting line
 * becomes its own line inside the block (surrounding blank lines trimmed); the noteKind prefix,
 * if any, lands on the first content line. No colon-guarding needed — PlantUML's block form has
 * no `:` delimiter to protect, unlike a single-line Mermaid note.
 */
/** `end note` → `<U+0065>nd note`: the same text on screen, no longer a command to the parser. */
function unicodeFirst(line: string): string {
  const first = line.codePointAt(0)!;
  return `${unicodeCode(line)}${line.slice(first > 0xffff ? 2 : 1)}`;
}

function noteBlock(
  participantIds: readonly string[],
  text: string,
  noteKind: NoteKind | undefined,
  depth: number,
  aliasOf: (id: string) => string,
): string[] {
  const pad = INDENT.repeat(depth);
  const anchor = participantIds.map(aliasOf).join(',');
  const rawLines = wrapNoteLines(text);
  while (rawLines.length > 0 && rawLines[0] === '') rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  // Some content lines are still read as commands inside a note block: `end note` (and its
  // `hnote`/`rnote` spellings) closes the block early, `@enduml` ends the diagram, and a leading `!`
  // is a preprocessor directive (`!include` would even run). A leading `'` is a comment (the line
  // vanishes) and `/'` opens a block comment that swallows `end note` and everything after it — a
  // SQL or shell snippet can start either way. Writing the first character as a `<U+XXXX>` code keeps
  // each literal and renders as just that character — the `~` escape doesn't: checked against the
  // PlantUML server, `~end note` keeps its tilde on screen and `~@enduml` renders as a lone `~`.
  const contentLines = (rawLines.length > 0 ? rawLines : ['Note']).map((line) => {
    const escaped = escapePlantUmlText(line);
    return /^\s*(?:!|@|'|\/'|end\s*[hr]?note\b)/i.test(escaped) ? unicodeFirst(escaped.trimStart()) : escaped;
  });
  const prefix = noteKind ? (NOTE_PREFIX[noteKind] ?? '') : '';

  const lines = [`${pad}note over ${anchor}`, `${INDENT.repeat(depth + 1)}${prefix}${contentLines[0]}`];
  for (const line of contentLines.slice(1)) lines.push(`${INDENT.repeat(depth + 1)}${line}`);
  lines.push(`${pad}end note`);
  return lines;
}

function renderElement(element: SequenceElement, depth: number, aliasOf: (id: string) => string): string[] {
  const pad = INDENT.repeat(depth);
  switch (element.kind) {
    case 'message':
      return [
        `${pad}${aliasOf(element.from)} ${ARROW[element.interaction]} ${aliasOf(element.to)}: ${sanitizeMessageLabel(element.label)}`,
      ];
    case 'note':
      return noteBlock(element.participantIds, element.text, element.noteKind, depth, aliasOf);
    case 'group': {
      const lines = [`${pad}group ${sanitizeGroupLabel(element.label)}`];
      for (const child of element.children) lines.push(...renderElement(child, depth + 1, aliasOf));
      lines.push(`${pad}end`);
      return lines;
    }
  }
}

export function toPlantUml(model: SequenceModel): string {
  const aliasById = new Map(model.participants.map((p) => [p.id, p.alias]));
  const aliasOf = (id: string) => aliasById.get(id) ?? id;

  const lines: string[] = [];
  const title = model.title.trim();
  if (title) lines.push(`' Generated by Draft Canvas from "${title.replace(/\r\n?|\n/g, ' ')}"`);
  lines.push('@startuml');
  for (const participant of model.participants) {
    lines.push(`${plantUmlKeyword(participant.kind)} "${sanitizeParticipantName(participant.label)}" as ${participant.alias}`);
  }
  if (model.elements.length > 0) {
    lines.push('');
    for (const element of model.elements) lines.push(...renderElement(element, 0, aliasOf));
  }
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}
