/**
 * SequenceModel → Mermaid `sequenceDiagram` text. A pure, independent consumer of the model —
 * never derived from (or shared implementation with) `plantuml.ts`.
 */
import type { NoteKind } from '../document/types';
import type { InteractionKind, ParticipantKind, SequenceElement, SequenceModel } from './types';
import { wrapNoteLines } from './wrap';

/** Mermaid's dedicated arrow forms for each message shape: `->>` (solid, filled arrowhead) for a
 *  synchronous call, `-->>` (dashed, filled arrowhead) for a reply, `-)` (solid, open arrowhead —
 *  Mermaid's own fire-and-forget convention) for an asynchronous message. */
const ARROW: Record<InteractionKind, string> = {
  sync: '->>',
  response: '-->>',
  async: '-)',
};

/**
 * Mermaid's sequence-diagram grammar has no neutral "just a labeled span" fragment keyword — only
 * `loop`/`alt`/`opt`/`par`/`critical`/`break`/`rect`/`box`, each carrying its own conditional/
 * loop/parallel meaning. `rect` is the closest valid, renderable substitute for a Flow's own
 * group. The fill is one fixed, theme-neutral constant — never per-flow, never accent-derived —
 * so it can never be mistaken for styling intent and stays legible in a dark-mode viewer.
 */
const GROUP_FILL = 'rgb(240, 240, 240)';

const INDENT = '    ';

function mermaidKeyword(kind: ParticipantKind): 'actor' | 'participant' {
  return kind === 'actor' ? 'actor' : 'participant';
}

/** Mermaid documents wrapping a participant's display name in quotes as the way to include
 *  otherwise-reserved characters (colons included) in an aliased declaration — used unconditionally
 *  here rather than only when "needed," so output is deterministic regardless of content. */
function sanitizeParticipantName(label: string): string {
  return label.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
}

/** A message's label runs to the end of its line with no quoting mechanism of its own; `:` is the
 *  delimiter Mermaid uses right after the arrow, so any literal colon in the text is guarded
 *  defensively rather than relying on exactly-once-delimiter parsing. */
function sanitizeMessageLabel(label: string): string {
  const clean = label.replace(/\r?\n/g, ' ').replace(/:/g, '-').trim();
  return clean || 'Message';
}

/**
 * A note's text, collapsed to Mermaid's single line — this format has no real multi-line block
 * form, unlike PlantUML's `note over ... end note`. The text is wrapped first (`wrapNoteLines`,
 * on the raw text, so entity escaping below can't skew the measured width), `&`/`<`/`>` are then
 * HTML-escaped (so literal code containing `<div>` or `&&` can't be misread by Mermaid's HTML-ish
 * note renderer), each line is colon-guarded the same defensive way a message label already is
 * (`:` is still Mermaid's own note-text delimiter), and the lines are joined with a literal
 * `<br/>` — Mermaid's own documented line-break token inside note text, not a hack. Lossy for text
 * containing a literal colon or angle bracket — a deliberate safety-over-fidelity tradeoff.
 */
function sanitizeNoteText(text: string): string {
  const lines = wrapNoteLines(text)
    .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/:/g, '-').trim())
    .filter((line) => line.length > 0);
  return lines.join('<br/>') || 'Note';
}

/** Portable, CSS-free prefixes — the source itself must carry the distinction, since a `.mmd`/
 *  `.puml` file has no access to Draft Canvas's own note-kind colors. A plain Note gets none. */
const NOTE_PREFIX: Partial<Record<NoteKind, string>> = {
  question: 'Question: ',
  warning: 'Warning: ',
  decision: 'Decision: ',
};

function noteLine(
  participantIds: readonly string[],
  text: string,
  noteKind: NoteKind | undefined,
  aliasOf: (id: string) => string,
): string {
  const anchor = participantIds.map(aliasOf).join(',');
  const prefix = noteKind ? (NOTE_PREFIX[noteKind] ?? '') : '';
  return `Note over ${anchor}: ${prefix}${sanitizeNoteText(text)}`;
}

/** The participant(s) a synthesized group-title Note anchors to: the first message's or note's
 *  own participant id(s), found by walking the group's children in order. `build.ts` never emits
 *  an empty group, and every message/note it does emit carries participant ids, so this always
 *  resolves for real output — the empty-array fallback only matters for a hand-built model in a
 *  test. */
function titleAnchor(children: SequenceElement[]): readonly string[] {
  for (const child of children) {
    if (child.kind === 'message') return child.from === child.to ? [child.from] : [child.from, child.to];
    if (child.kind === 'note') return child.participantIds;
  }
  return [];
}

function renderElement(element: SequenceElement, depth: number, aliasOf: (id: string) => string): string[] {
  const pad = INDENT.repeat(depth);
  switch (element.kind) {
    case 'message':
      return [
        `${pad}${aliasOf(element.from)}${ARROW[element.interaction]}${aliasOf(element.to)}: ${sanitizeMessageLabel(element.label)}`,
      ];
    case 'note':
      return [`${pad}${noteLine(element.participantIds, element.text, element.noteKind, aliasOf)}`];
    case 'group': {
      const anchor = titleAnchor(element.children).map(aliasOf).join(',');
      const lines = [`${pad}rect ${GROUP_FILL}`];
      if (anchor) lines.push(`${INDENT.repeat(depth + 1)}Note over ${anchor}: ${sanitizeNoteText(element.label)}`);
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
      return [`${pad}%% -- ${element.label} --`];
  }
}

export function toMermaid(model: SequenceModel): string {
  const aliasById = new Map(model.participants.map((p) => [p.id, p.alias]));
  const aliasOf = (id: string) => aliasById.get(id) ?? id;

  const lines: string[] = [];
  const title = model.title.trim();
  if (title) lines.push(`%% Generated by Draft Canvas from "${title.replace(/\r?\n/g, ' ')}"`);
  lines.push('sequenceDiagram');
  for (const participant of model.participants) {
    lines.push(
      `${INDENT}${mermaidKeyword(participant.kind)} ${participant.alias} as "${sanitizeParticipantName(participant.label)}"`,
    );
  }
  if (model.elements.length > 0) {
    lines.push('');
    for (const element of model.elements) lines.push(...renderElement(element, 1, aliasOf));
  }
  return `${lines.join('\n')}\n`;
}
