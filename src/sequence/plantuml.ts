/**
 * SequenceModel → PlantUML text. A pure, independent consumer of the model — built directly from
 * `SequenceModel`, never by converting `mermaid.ts`'s output.
 */
import type { InteractionKind, ParticipantKind, SequenceModel } from './types';

/** PlantUML's own conventions: `->` (solid, filled arrowhead) for a synchronous call, `-->`
 *  (dashed, filled arrowhead) for a reply, `->>` (solid, open/thin arrowhead — PlantUML's
 *  documented async convention) for an asynchronous message. */
const ARROW: Record<InteractionKind, string> = {
  sync: '->',
  response: '-->',
  async: '->>',
};

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

export function toPlantUml(model: SequenceModel): string {
  const lines: string[] = ['@startuml'];
  for (const participant of model.participants) {
    lines.push(`${plantUmlKeyword(participant.kind)} "${sanitizeParticipantName(participant.label)}" as ${participant.id}`);
  }
  for (const message of model.messages) {
    lines.push(`${message.from} ${ARROW[message.interaction]} ${message.to}: ${sanitizeMessageLabel(message.label)}`);
  }
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}
