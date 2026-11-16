/**
 * A native sequence → PlantUML text.
 *
 * PlantUML has a word for everything a sequence here can hold — including `ref over`, which Mermaid
 * lacks — so nothing is approximated: `box` for a group, `->`, `->>` and `-->` for the three
 * arrows, `activate`/`deactivate`, `create` and `destroy`, and `alt`/`else`, `opt`, `loop`,
 * `par`/`else`, `critical` and `break`.
 */
import { sequenceOf } from '../../document/sequenceModel';
import type { DraftNode, SeqItem, SeqMessage, SeqParticipant } from '../../document/types';
import { noteBlock, plantUmlKeyword, sanitizeGroupLabel, sanitizeMessageLabel, sanitizeParticipantName } from '../plantuml';
import { aliasesOf, createdBy, participantKindOf, Working } from './shared';

const INDENT = '    ';

export function sequenceToPlantUml(node: DraftNode): string {
  const sequence = sequenceOf(node);
  const alias = aliasesOf(sequence);
  const made = createdBy(sequence);
  const madeLater = new Set(made.values());
  const working = new Working();
  const of = (id: string): string => alias.get(id) ?? id;
  const lines: string[] = [];
  const title = (node.text ?? '').trim();
  if (title) lines.push(`' Sequence "${title.replace(/\r\n?|\n/g, ' ')}", from Draft Canvas`);
  lines.push('@startuml');

  const declare = (participant: SeqParticipant, create = false) =>
    `${create ? 'create ' : ''}${plantUmlKeyword(participantKindOf(participant))} "${sanitizeParticipantName(participant.name || 'Participant')}" as ${of(participant.id)}`;
  const grouped = new Map<string, string>();
  for (const group of sequence.groups ?? []) for (const id of group.participantIds) grouped.set(id, group.id);
  let open: string | null = null;
  for (const participant of sequence.participants) {
    if (madeLater.has(participant.id)) continue;
    const groupId = grouped.get(participant.id) ?? null;
    if (groupId !== open) {
      if (open !== null) lines.push('end box');
      const group = sequence.groups?.find((entry) => entry.id === groupId);
      if (group) lines.push(`box "${sanitizeParticipantName(group.name || 'Group')}"`);
      open = groupId;
    }
    lines.push(declare(participant));
  }
  if (open !== null) lines.push('end box');

  const message = (item: SeqMessage, pad: string): string[] => {
    const out: string[] = [];
    const creates = made.get(item.id);
    const created = creates ? sequence.participants.find((participant) => participant.id === creates) : undefined;
    if (created) out.push(`${pad}${declare(created, true)}`);
    const arrow = item.kind === 'async' ? '->>' : item.kind === 'reply' || item.kind === 'create' ? '-->' : '->';
    out.push(`${pad}${of(item.from)} ${arrow} ${of(item.to)}: ${sanitizeMessageLabel(item.label)}`);
    if (item.deactivate && working.end(item.from)) out.push(`${pad}deactivate ${of(item.from)}`);
    if (item.kind === 'destroy') {
      working.clear(item.to);
      out.push(`${pad}destroy ${of(item.to)}`);
    } else if (item.activate) {
      working.start(item.to);
      out.push(`${pad}activate ${of(item.to)}`);
    }
    return out;
  };

  const render = (items: readonly SeqItem[], depth: number) => {
    const pad = INDENT.repeat(depth);
    for (const item of items) {
      if (item.t === 'message') {
        lines.push(...message(item, pad));
      } else if (item.t === 'note') {
        const block = noteBlock(item.over.length > 1 ? [item.over[0]!, item.over[item.over.length - 1]!] : item.over, item.text, undefined, depth, of, false);
        // `noteBlock` writes "note over A,B"; a note beside a lifeline says which side instead.
        if (item.side) block[0] = `${pad}note ${item.side} of ${of(item.over[0]!)}`;
        lines.push(...block);
      } else if (item.operator === 'ref') {
        const covered = (item.covers?.length ? item.covers : sequence.participants.map((participant) => participant.id)).map(of);
        if (covered.length > 0) lines.push(`${pad}ref over ${covered.join(', ')} : ${sanitizeGroupLabel(item.label ?? 'another interaction')}`);
      } else {
        item.operands.forEach((branch, index) => {
          const guard = branch.guard ? ` ${sanitizeGroupLabel(branch.guard)}` : '';
          lines.push(`${pad}${index === 0 ? item.operator : 'else'}${guard}`);
          render(branch.items, depth + 1);
        });
        lines.push(`${pad}end`);
      }
    }
  };
  if (sequence.items.length > 0) {
    lines.push('');
    render(sequence.items, 0);
  }
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}
