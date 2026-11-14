/**
 * Commands for a sequence and for whatever is selected inside one. Thin, like every command: each
 * names an action in `store/sequenceActions.ts` and nothing else. The palette, the right-click menu
 * and the inspector's quick actions all read from here, so a sequence offers the same things under
 * the same names wherever it is asked.
 */
import { sequenceFlowId } from '../document/sequenceFlow';
import { findItem, findOperand, isBranching, messagesOf, sequenceOf } from '../document/sequenceModel';
import type { DraftNode, SeqOperator } from '../document/types';
import { isLinkable } from '../document/sequenceLinks';
import { liveSequenceFocus } from '../sequence/focus';
import { sequenceActions } from '../store/sequenceActions';
import type { Command, CommandContext } from './types';

const WRAPS: { operator: Exclude<SeqOperator, 'ref'>; title: string; keywords: string[] }[] = [
  { operator: 'alt', title: 'Wrap in condition', keywords: ['alt', 'if', 'else', 'branch', 'alternative'] },
  { operator: 'opt', title: 'Wrap in optional', keywords: ['opt', 'maybe', 'if'] },
  { operator: 'loop', title: 'Wrap in loop', keywords: ['repeat', 'while', 'for each', 'retry'] },
  { operator: 'par', title: 'Wrap in parallel', keywords: ['par', 'concurrent', 'at the same time'] },
  { operator: 'break', title: 'Wrap in break', keywords: ['exception', 'error', 'abort', 'stop'] },
  { operator: 'critical', title: 'Wrap in critical section', keywords: ['atomic', 'lock', 'transaction'] },
];

/** What the whole sequence offers, whatever is or is not selected inside it. */
export function sequenceQuickCommands(node: DraftNode): Command[] {
  const sequence = sequenceOf(node);
  return [
    {
      id: 'seq-add-participant',
      title: 'Add participant',
      group: 'selection',
      primary: true,
      keywords: ['lifeline', 'actor', 'service', 'who'],
      hint: 'Someone or something that takes part',
      shortcut: 'P',
      run: () => sequenceActions.edit(node.id, { kind: 'new-participant', index: sequence.participants.length }),
    },
    // Presenting it is the canvas's own presentation, told one message at a time
    // (`document/sequenceFlow.ts`): nothing is added to the diagram's flows.
    ...(messagesOf(sequence).length > 0
      ? [
          {
            id: 'seq-present',
            title: 'Present this sequence',
            group: 'selection' as const,
            primary: true,
            keywords: ['walk through', 'step through', 'play', 'explain', 'story'],
            hint: 'One message at a time',
            run: (inner: CommandContext) => inner.onPresent(sequenceFlowId(node.id)),
          },
        ]
      : []),
    ...(sequence.participants.length > 0
      ? [
          {
            id: 'seq-add-reference',
            title: 'Add reference to another interaction',
            group: 'selection' as const,
            keywords: ['ref', 'interaction use', 'see also', 'sub sequence'],
            hint: 'Stands for a sequence drawn elsewhere',
            run: () => void sequenceActions.addReference(node.id, [], { operandId: null, index: sequence.items.length }),
          },
        ]
      : []),
  ];
}

/** What can be done to the thing selected inside `node`, if anything is. */
export function sequenceCommands(ctx: CommandContext, node: DraftNode): Command[] {
  if (node.type !== 'sequence') return [];
  const sequence = sequenceOf(node);
  const commands: Command[] = [...sequenceQuickCommands(node)];
  const held = ctx.ui.sequenceFocus?.nodeId === node.id ? liveSequenceFocus(sequence, ctx.ui.sequenceFocus) : null;
  if (!held) return commands;
  const [id] = held.ids;
  if (!id) return commands;
  const add = (command: Omit<Command, 'group'>) => commands.push({ group: 'selection', ...command });

  if (held.kind === 'participant') {
    if (held.ids.length === 1) {
      add({ id: 'seq-rename', title: 'Rename participant', shortcut: 'Enter', run: () => sequenceActions.edit(node.id, { kind: 'participant', id }) });
      if (sequence.groups?.some((group) => group.participantIds.includes(id))) {
        add({ id: 'seq-leave-group', title: 'Take out of group', run: () => sequenceActions.leaveGroup(node.id, id) });
      }
    }
    add({ id: 'seq-group', title: held.ids.length > 1 ? 'Group participants' : 'Put in a group', keywords: ['box', 'together'], run: () => sequenceActions.groupParticipants(node.id, held.ids) });
    add({ id: 'seq-delete', title: held.ids.length > 1 ? 'Delete participants' : 'Delete participant', shortcut: 'Delete', run: () => sequenceActions.removeParticipants(node.id, held.ids) });
    return commands;
  }

  if (held.kind === 'group') {
    add({ id: 'seq-rename', title: 'Rename group', shortcut: 'Enter', run: () => sequenceActions.edit(node.id, { kind: 'group', id }) });
    add({ id: 'seq-ungroup', title: 'Ungroup participants', run: () => sequenceActions.ungroup(node.id, id) });
    return commands;
  }

  if (held.kind === 'operand') {
    const found = findOperand(sequence, id);
    if (!found) return commands;
    add({ id: 'seq-edit', title: 'Edit condition', shortcut: 'Enter', run: () => sequenceActions.edit(node.id, { kind: 'guard', id }) });
    if (isBranching(found.fragment.operator)) add({ id: 'seq-add-branch', title: 'Add branch below', run: () => void sequenceActions.addBranch(node.id, found.fragment.id, id) });
    if (found.fragment.operands.length > 1) add({ id: 'seq-remove-branch', title: 'Remove branch', hint: 'Its messages stay', shortcut: 'Delete', run: () => sequenceActions.removeBranch(node.id, id) });
    return commands;
  }

  const item = held.ids.length === 1 ? findItem(sequence, id)?.item : undefined;
  if (item?.t === 'message') {
    add({ id: 'seq-edit', title: 'Edit message', shortcut: 'Enter', run: () => sequenceActions.edit(node.id, { kind: 'message', id }) });
    if (item.kind !== 'reply' && item.from !== item.to) add({ id: 'seq-add-reply', title: 'Add reply', keywords: ['return', 'response', 'answer'], run: () => void sequenceActions.addReply(node.id, id) });
    if (item.from !== item.to) add({ id: 'seq-reverse', title: 'Reverse message', keywords: ['flip', 'swap', 'direction'], run: () => sequenceActions.reverse(node.id, id) });
  } else if (item?.t === 'note') {
    add({ id: 'seq-edit', title: 'Edit note', shortcut: 'Enter', run: () => sequenceActions.edit(node.id, { kind: 'note', id }) });
  } else if (item?.t === 'fragment') {
    if (item.operator === 'ref') add({ id: 'seq-edit', title: 'Edit reference', shortcut: 'Enter', run: () => sequenceActions.edit(node.id, { kind: 'reference', id }) });
    else {
      add({ id: 'seq-unwrap', title: 'Unwrap fragment', hint: 'Its messages stay', keywords: ['remove frame', 'ungroup'], run: () => sequenceActions.unwrap(node.id, id) });
      if (isBranching(item.operator)) add({ id: 'seq-add-branch', title: item.operator === 'alt' ? 'Add else branch' : 'Add branch', run: () => void sequenceActions.addBranch(node.id, id) });
    }
  }
  for (const wrap of WRAPS) {
    add({ id: `seq-wrap-${wrap.operator}`, title: wrap.title, keywords: ['fragment', 'frame', ...wrap.keywords], run: () => void sequenceActions.wrap(node.id, held.ids, wrap.operator) });
  }
  if (item) add({ id: 'seq-duplicate', title: 'Duplicate', run: () => sequenceActions.duplicate(node.id, id) });
  add({
    id: 'seq-delete',
    title: item?.t === 'fragment' && item.operator !== 'ref' ? 'Delete with its messages' : 'Delete',
    run: () => sequenceActions.removeItems(node.id, held.ids),
  });
  return commands;
}

/**
 * "Sequence from these": the selected architecture shapes become the participants of a new sequence
 * beside them, each still standing for its shape. No messages are drawn — which shapes are
 * connected says nothing about who calls whom first.
 */
export function sequenceFromSelectionCommands(ctx: CommandContext): Command[] {
  const chosen = new Set(ctx.editor.selection.nodes);
  const shapes = ctx.editor.document.nodes.filter((node) => chosen.has(node.id) && isLinkable(node));
  if (shapes.length === 0) return [];
  return [
    {
      id: 'sequence-from-selection',
      title: shapes.length === 1 ? 'Start a sequence with this' : 'Sequence from these',
      group: 'selection',
      keywords: ['sequence diagram', 'participants', 'lifelines', 'interaction'],
      hint: shapes.length === 1 ? 'A sequence beside it, with it as the first participant' : `A sequence beside them, with these ${shapes.length} as its participants`,
      run: () => void sequenceActions.createFromShapes(shapes.map((shape) => shape.id)),
    },
  ];
}

export const SEQUENCE_WRAP_IDS = WRAPS.map((wrap) => `seq-wrap-${wrap.operator}`);
