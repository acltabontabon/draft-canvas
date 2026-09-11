/**
 * SequenceModel → PlantUML text. A pure, independent consumer of the model — built directly from
 * `SequenceModel`, never by converting `mermaid.ts`'s output.
 */
import type { NoteKind } from '../document/types';
import type { InteractionKind, ParticipantKind, SequenceElement, SequenceModel } from './types';

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

/** PlantUML declares a participant as `<keyword> "<display name>" as <alias>` — the quoted name
 *  may contain any character except an unescaped double quote. Newlines are collapsed since a
 *  declaration is a single line. */
function sanitizeParticipantName(label: string): string {
  return label.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
}

/** A PlantUML message's text runs to the end of the line, with no delimiter character of its own
 *  to guard (unlike Mermaid's `:`) — only newlines need collapsing to keep it on one line. */
function sanitizeMessageLabel(label: string): string {
  const clean = label.replace(/\r?\n/g, ' ').trim();
  return clean || 'Message';
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
 * switching on content length the way Mermaid has to. Each source line becomes its own line
 * inside the block, verbatim (only surrounding blank lines trimmed); the noteKind prefix, if any,
 * lands on the first content line. No colon-guarding needed — PlantUML's block form has no `:`
 * delimiter to protect, unlike a single-line Mermaid note.
 */
function noteBlock(
  participantIds: readonly string[],
  text: string,
  noteKind: NoteKind | undefined,
  depth: number,
  aliasOf: (id: string) => string,
): string[] {
  const pad = INDENT.repeat(depth);
  const anchor = participantIds.map(aliasOf).join(',');
  const rawLines = text.split(/\r?\n/).map((l) => l.trim());
  while (rawLines.length > 0 && rawLines[0] === '') rawLines.shift();
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const contentLines = rawLines.length > 0 ? rawLines : ['Note'];
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
      const lines = [`${pad}group ${element.label}`];
      for (const child of element.children) lines.push(...renderElement(child, depth + 1, aliasOf));
      lines.push(`${pad}end`);
      return lines;
    }
    // Reserved for a future explicit Flow relationship — see `SequenceAlternative`'s own doc
    // comment in types.ts. `build.ts` never constructs these in V1; kept renderable so the type
    // union doesn't force an unsafe cast if it ever does.
    case 'alt': {
      const lines: string[] = [];
      element.branches.forEach((branch, i) => {
        lines.push(`${pad}${i === 0 ? 'alt' : 'else'} ${branch.label}`);
        for (const child of branch.children) lines.push(...renderElement(child, depth + 1, aliasOf));
      });
      lines.push(`${pad}end`);
      return lines;
    }
    case 'loop': {
      const lines = [`${pad}loop ${element.label}`];
      for (const child of element.children) lines.push(...renderElement(child, depth + 1, aliasOf));
      lines.push(`${pad}end`);
      return lines;
    }
    case 'par': {
      const lines: string[] = [];
      element.branches.forEach((branch, i) => {
        lines.push(`${pad}${i === 0 ? 'par' : 'and'} ${branch.label}`);
        for (const child of branch.children) lines.push(...renderElement(child, depth + 1, aliasOf));
      });
      lines.push(`${pad}end`);
      return lines;
    }
    case 'divider':
      return [`${pad}== ${element.label} ==`];
  }
}

export function toPlantUml(model: SequenceModel): string {
  const aliasById = new Map(model.participants.map((p) => [p.id, p.alias]));
  const aliasOf = (id: string) => aliasById.get(id) ?? id;

  const lines: string[] = [];
  const title = model.title.trim();
  if (title) lines.push(`' Generated by Draft Canvas from "${title.replace(/\r?\n/g, ' ')}"`);
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
