/**
 * A native sequence → Mermaid `sequenceDiagram` text.
 *
 * Everything Mermaid can say is said in its own words: participants and actors, `box` for a group,
 * the three arrows, `+`/`-` for work starting and ending, `create` and `destroy`, and `alt`/`else`,
 * `opt`, `loop`, `par`/`and`, `critical` and `break` for fragments. What it cannot say — a
 * reference to another interaction — is written as a note with a comment beside it saying so, so
 * nothing is dropped without a trace.
 */
import { sequenceOf } from '../../document/sequenceModel';
import type { DraftNode, SeqItem, SeqMessage, SeqParticipant } from '../../document/types';
import { escapeMermaidText, mermaidKeyword, sanitizeMessageLabel, sanitizeNoteText, sanitizeParticipantName } from '../mermaid';
import { aliasesOf, createdBy, participantKindOf, Working } from './shared';

const INDENT = '    ';

const oneLine = (text: string): string => escapeMermaidText(text.replace(/\r\n?|\n/g, ' ').trim());

/** Both formats take a note "over" one participant or from one to another: the first and the last. */
const spanOf = (over: readonly string[]): string[] => (over.length > 1 ? [over[0]!, over[over.length - 1]!] : [...over]);

export function sequenceToMermaid(node: DraftNode): string {
  const sequence = sequenceOf(node);
  const alias = aliasesOf(sequence);
  const made = createdBy(sequence);
  const madeLater = new Set(made.values());
  const working = new Working();
  const of = (id: string): string => alias.get(id) ?? id;
  const lines: string[] = [];
  const title = (node.text ?? '').trim();
  if (title) lines.push(`%% Sequence "${oneLine(title)}", from Draft Canvas`);
  lines.push('sequenceDiagram');

  const declare = (participant: SeqParticipant, pad: string, create = false) =>
    `${pad}${create ? 'create ' : ''}${mermaidKeyword(participantKindOf(participant))} ${of(participant.id)} as ${sanitizeParticipantName(participant.name || 'Participant')}`;
  const grouped = new Map<string, string>();
  for (const group of sequence.groups ?? []) for (const id of group.participantIds) grouped.set(id, group.id);
  let open: string | null = null;
  for (const participant of sequence.participants) {
    if (madeLater.has(participant.id)) continue;
    const groupId = grouped.get(participant.id) ?? null;
    if (groupId !== open) {
      if (open !== null) lines.push(`${INDENT}end`);
      const group = sequence.groups?.find((entry) => entry.id === groupId);
      // `transparent` first: Mermaid reads a box's first word as its colour when it can, so a group
      // called "Blue team" would otherwise be painted blue and titled "team".
      if (group) lines.push(`${INDENT}box transparent ${oneLine(group.name) || 'Group'}`);
      open = groupId;
    }
    lines.push(declare(participant, open === null ? INDENT : INDENT.repeat(2)));
  }
  if (open !== null) lines.push(`${INDENT}end`);

  const message = (item: SeqMessage, pad: string): string[] => {
    const out: string[] = [];
    const creates = made.get(item.id);
    const created = creates ? sequence.participants.find((participant) => participant.id === creates) : undefined;
    if (created) out.push(declare(created, pad, true));
    if (item.kind === 'destroy') out.push(`${pad}destroy ${of(item.to)}`);
    const arrow = item.kind === 'async' ? '-)' : item.kind === 'reply' || item.kind === 'create' ? '-->>' : item.kind === 'destroy' ? '-x' : '->>';
    // The sender's work ends before the receiver's begins, as it is drawn.
    const ends = item.deactivate && working.end(item.from) ? '-' : '';
    let starts = '';
    if (item.kind === 'destroy') working.clear(item.to);
    else if (item.activate) {
      working.start(item.to);
      starts = '+';
    }
    out.push(`${pad}${of(item.from)}${arrow}${starts || ends}${of(item.to)}: ${sanitizeMessageLabel(item.label)}`);
    // Mermaid takes one mark per arrow; a message that both ends and starts work says the other on its own line.
    if (starts && ends) out.push(`${pad}deactivate ${of(item.from)}`);
    return out;
  };

  const render = (items: readonly SeqItem[], depth: number) => {
    const pad = INDENT.repeat(depth);
    for (const item of items) {
      if (item.t === 'message') {
        lines.push(...message(item, pad));
      } else if (item.t === 'note') {
        const anchor = item.side ? `${item.side} of ${of(item.over[0]!)}` : `over ${spanOf(item.over).map(of).join(',')}`;
        lines.push(`${pad}Note ${anchor}: ${sanitizeNoteText(item.text)}`);
      } else if (item.operator === 'ref') {
        const covered = (item.covers?.length ? item.covers : sequence.participants.map((participant) => participant.id)).map(of);
        const span = covered.length > 1 ? `${covered[0]},${covered[covered.length - 1]}` : covered[0];
        lines.push(`${pad}%% Mermaid has no reference to another interaction: written as a note.`);
        if (span) lines.push(`${pad}Note over ${span}: ref: ${sanitizeNoteText(item.label ?? 'another interaction')}`);
      } else {
        const next = item.operator === 'par' ? 'and' : item.operator === 'critical' ? 'option' : 'else';
        item.operands.forEach((branch, index) => {
          const guard = branch.guard ? ` ${oneLine(branch.guard)}` : '';
          lines.push(`${pad}${index === 0 ? item.operator : next}${guard}`);
          render(branch.items, depth + 1);
        });
        lines.push(`${pad}end`);
      }
    }
  };
  if (sequence.items.length > 0) {
    lines.push('');
    render(sequence.items, 1);
  }
  return `${lines.join('\n')}\n`;
}
