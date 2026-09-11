/**
 * SequenceModel → Mermaid `sequenceDiagram` text. A pure, independent consumer of the model —
 * never derived from (or shared implementation with) `plantuml.ts`.
 */
import type { InteractionKind, ParticipantKind, SequenceModel } from './types';

/** Mermaid's dedicated arrow forms for each message shape: `->>` (solid, filled arrowhead) for a
 *  synchronous call, `-->>` (dashed, filled arrowhead) for a reply, `-)` (solid, open arrowhead —
 *  Mermaid's own fire-and-forget convention) for an asynchronous message. */
const ARROW: Record<InteractionKind, string> = {
  sync: '->>',
  response: '-->>',
  async: '-)',
};

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

export function toMermaid(model: SequenceModel): string {
  const lines: string[] = ['sequenceDiagram'];
  for (const participant of model.participants) {
    lines.push(`    ${mermaidKeyword(participant.kind)} ${participant.id} as "${sanitizeParticipantName(participant.label)}"`);
  }
  for (const message of model.messages) {
    lines.push(`    ${message.from}${ARROW[message.interaction]}${message.to}: ${sanitizeMessageLabel(message.label)}`);
  }
  return `${lines.join('\n')}\n`;
}
