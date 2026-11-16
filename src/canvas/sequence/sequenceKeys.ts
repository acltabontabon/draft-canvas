/**
 * The keyboard, while something inside a sequence is selected.
 *
 * It follows the canvas's own grammar, so there is nothing new to learn: arrows move the thing
 * that is selected (a message up or down the order, a participant along the row), ⌥arrows move the
 * selection instead, Enter edits, Delete removes, Tab takes the suggestion on offer and `]` / `[`
 * turn it over, Escape steps back out. Everything a pointer can do inside a sequence can be done
 * from here.
 *
 * The editor's own handler asks this first and stops when it answers true — which is what keeps
 * Delete from removing the whole sequence when one message was meant.
 */
import { findItem, findOperand, itemsAt, messagesOf, walkItems, type SeqSlot } from '../../document/sequenceModel';
import type { DraftSequence, SeqItem } from '../../document/types';
import { isActivatableTarget, isInOwnKeyboardRegion } from '../../lib/isEditableTarget';
import { moveProblem } from '../../sequence/check';
import { itemRange, liveSequenceFocus, neighbourItem, neighbourParticipant, readingOrder, type SequenceEditTarget, type SequenceFocus } from '../../sequence/focus';
import { nextFor } from '../../sequence/suggest';
import { useEditorStore } from '../../store/editorStore';
import { sequenceActions, sequenceIn } from '../../store/sequenceActions';
import { useUiStore } from '../../store/uiStore';

/** What Enter opens for the thing selected. */
function editTargetOf(sequence: DraftSequence, focus: SequenceFocus): SequenceEditTarget | null {
  const id = focus.ids[0];
  if (!id) return null;
  if (focus.kind === 'participant') return { kind: 'participant', id };
  if (focus.kind === 'group') return { kind: 'group', id };
  if (focus.kind === 'operand') return { kind: 'guard', id };
  const item = findItem(sequence, id)?.item;
  if (!item) return null;
  if (item.t === 'message') return { kind: 'message', id };
  if (item.t === 'note') return { kind: 'note', id };
  if (item.operator === 'ref') return { kind: 'reference', id };
  return item.operands[0] ? { kind: 'guard', id: item.operands[0].id } : null;
}

const holdsSomething = (item: SeqItem): boolean => item.t === 'fragment' && item.operands.some((branch) => branch.items.length > 0);

/**
 * Where one step up or down takes an item: past its neighbour, into a fragment that is in the way
 * (its nearest branch), out of the branch it is in when it is already at the edge of it. Null at
 * the very top and the very bottom.
 */
export function stepSlot(sequence: DraftSequence, id: string, direction: 1 | -1): SeqSlot | null {
  const found = findItem(sequence, id);
  if (!found) return null;
  const operandId = found.at.operand?.id ?? null;
  const list = itemsAt(sequence, operandId) ?? [];
  const index = found.at.index;
  const neighbour = list[index + direction];
  if (neighbour) {
    if (neighbour.t === 'fragment' && neighbour.operands.length > 0) {
      const branch = direction === 1 ? neighbour.operands[0]! : neighbour.operands[neighbour.operands.length - 1]!;
      return { operandId: branch.id, index: direction === 1 ? 0 : branch.items.length };
    }
    return { operandId, index: direction === 1 ? index + 2 : index - 1 };
  }
  const fragment = found.at.fragment;
  if (!fragment || !operandId) return null;
  const at = fragment.operands.findIndex((branch) => branch.id === operandId);
  const sibling = fragment.operands[at + direction];
  if (sibling) return { operandId: sibling.id, index: direction === 1 ? 0 : sibling.items.length };
  const outer = findItem(sequence, fragment.id);
  if (!outer) return null;
  return { operandId: outer.at.operand?.id ?? null, index: outer.at.index + (direction === 1 ? 1 : 0) };
}

function remove(nodeId: string, sequence: DraftSequence, focus: SequenceFocus): void {
  if (focus.kind === 'participant') return sequenceActions.removeParticipants(nodeId, focus.ids);
  if (focus.kind === 'group') return sequenceActions.ungroup(nodeId, focus.ids[0]!);
  if (focus.kind === 'operand') {
    const found = findOperand(sequence, focus.ids[0]!);
    if (found && found.fragment.operands.length > 1) sequenceActions.removeBranch(nodeId, focus.ids[0]!);
    else useUiStore.getState().notify('A fragment keeps its one branch. Select the fragment to unwrap or delete it.');
    return;
  }
  const only = focus.ids.length === 1 ? findItem(sequence, focus.ids[0]!)?.item : undefined;
  // A frame with messages in it is taken away from around them: Delete never takes messages nobody selected.
  if (only && holdsSomething(only)) {
    sequenceActions.unwrap(nodeId, only.id);
    useUiStore.getState().notify('Unwrapped. Its messages are still there.');
    return;
  }
  // The selection moves to what came before (or after), so deleting three in a row is Delete three times.
  const gone = new Set<string>();
  for (const id of focus.ids) {
    const item = findItem(sequence, id)?.item;
    if (item) walkItems([item], (inner) => void gone.add(inner.id));
  }
  const order = readingOrder(sequence).map((item) => item.id);
  const first = order.findIndex((id) => gone.has(id));
  const stay = [...order.slice(0, Math.max(0, first)).reverse(), ...order.slice(first)].find((id) => !gone.has(id));
  sequenceActions.removeItems(nodeId, focus.ids);
  if (stay) sequenceActions.select(nodeId, 'item', [stay]);
}

function move(nodeId: string, sequence: DraftSequence, focus: SequenceFocus, key: string): boolean {
  const id = focus.ids[0]!;
  if (focus.kind === 'participant' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const at = sequence.participants.findIndex((participant) => participant.id === id);
    sequenceActions.moveParticipant(nodeId, id, at + (key === 'ArrowRight' ? 1 : -1));
    return true;
  }
  if (focus.kind === 'operand' && (key === 'ArrowUp' || key === 'ArrowDown')) {
    sequenceActions.moveBranch(nodeId, id, key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (focus.kind === 'item' && focus.ids.length === 1 && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const slot = stepSlot(sequence, id, key === 'ArrowDown' ? 1 : -1);
    if (!slot) return true;
    const problem = moveProblem(sequence, id, slot);
    if (problem) useUiStore.getState().notify(problem);
    else sequenceActions.moveItem(nodeId, id, slot);
    return true;
  }
  // The arrow that means nothing for this thing still belongs to it: it must not nudge the whole sequence.
  return true;
}

function travel(nodeId: string, sequence: DraftSequence, focus: SequenceFocus, key: string, extend: boolean): boolean {
  const id = focus.ids[focus.ids.length - 1]!;
  const step: 1 | -1 = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (focus.kind === 'participant') {
    if (!vertical) {
      const next = neighbourParticipant(sequence, id, step);
      if (next) {
        const ids = extend
          ? focus.ids.includes(next) ? focus.ids.slice(0, -1) : [...focus.ids, next]
          : [next];
        sequenceActions.select(nodeId, 'participant', ids);
      }
    } else if (step === 1) {
      const first = messagesOf(sequence).find((message) => message.from === id || message.to === id) ?? messagesOf(sequence)[0];
      if (first) sequenceActions.select(nodeId, 'item', [first.id]);
    }
    return true;
  }
  if (focus.kind === 'item') {
    if (vertical) {
      const next = neighbourItem(sequence, id, step);
      if (next) sequenceActions.select(nodeId, 'item', extend ? itemRange(sequence, focus.ids[0]!, next) : [next]);
      else if (step === -1 && !extend && sequence.participants[0]) sequenceActions.select(nodeId, 'participant', [sequence.participants[0].id]);
      return true;
    }
    const item = findItem(sequence, id)?.item;
    if (item?.t === 'message') sequenceActions.select(nodeId, 'participant', [step === 1 ? item.to : item.from]);
    return true;
  }
  if (focus.kind === 'operand' && vertical) {
    const found = findOperand(sequence, id);
    const sibling = found?.fragment.operands[found.index + step];
    if (sibling) sequenceActions.select(nodeId, 'operand', [sibling.id]);
    else if (found) sequenceActions.select(nodeId, 'item', [found.fragment.id]);
  }
  return true;
}

/** Takes the suggestion showing for the selection, if there is one. */
function acceptGhost(nodeId: string, sequence: DraftSequence, focus: SequenceFocus): boolean {
  const offers = nextFor(sequence, focus);
  if (offers.length === 0) return false;
  const offer = offers[useUiStore.getState().sequenceGhost % offers.length]!;
  sequenceActions.addMessage(nodeId, { from: offer.from, to: offer.to, kind: offer.kind, replyTo: offer.replyTo }, offer.slot);
  return true;
}

/**
 * Handles a key for whatever is selected inside a sequence. True when it did; the editor's own
 * handler then leaves the key alone.
 */
export function handleSequenceKey(event: KeyboardEvent): boolean {
  const ui = useUiStore.getState();
  const editor = useEditorStore.getState();
  const meta = event.metaKey || event.ctrlKey;

  // Stepping in: with a sequence selected and nothing inside it, ⌘↓ goes inside — the same key that
  // looks inside a shape.
  if (!ui.sequenceFocus) {
    if (!(meta && event.key === 'ArrowDown') || editor.selection.nodes.length !== 1 || editor.selection.edges.length !== 0) return false;
    const nodeId = editor.selection.nodes[0]!;
    const sequence = sequenceIn(nodeId);
    if (!sequence) return false;
    event.preventDefault();
    const first = sequence.participants[0];
    if (first) sequenceActions.select(nodeId, 'participant', [first.id]);
    else sequenceActions.addDefaultParticipant(nodeId, 0);
    return true;
  }

  const nodeId = ui.sequenceFocus.nodeId;
  const sequence = sequenceIn(nodeId);
  const focus = sequence ? liveSequenceFocus(sequence, ui.sequenceFocus) : null;
  if (!sequence || !focus) return false;
  // A control with the keyboard (the inspector's own buttons and fields) keeps its keys.
  if (isInOwnKeyboardRegion(event.target)) return false;
  const done = () => {
    event.preventDefault();
    return true;
  };

  if (meta) {
    const key = event.key.toLowerCase();
    if (key === 'd' && focus.kind === 'item' && focus.ids.length === 1) {
      sequenceActions.duplicate(nodeId, focus.ids[0]!);
      return done();
    }
    if (key === 'g' && !event.shiftKey) {
      if (focus.kind === 'participant') sequenceActions.groupParticipants(nodeId, focus.ids);
      else if (focus.kind === 'item') sequenceActions.wrap(nodeId, focus.ids, 'opt');
      return done();
    }
    if (key === 'g' && event.shiftKey) {
      const item = focus.kind === 'item' ? findItem(sequence, focus.ids[0]!)?.item : undefined;
      if (focus.kind === 'group') sequenceActions.ungroup(nodeId, focus.ids[0]!);
      else if (item?.t === 'fragment') sequenceActions.unwrap(nodeId, item.id);
      return done();
    }
    if (event.key === 'ArrowUp') {
      ui.setSequenceFocus(null);
      return done();
    }
    return false;
  }

  switch (event.key) {
    case 'Escape':
      ui.setSequenceFocus(null);
      return done();
    case 'Backspace':
    case 'Delete':
      remove(nodeId, sequence, focus);
      return done();
    case 'Enter':
    case 'F2': {
      if (isActivatableTarget(event.target)) return false;
      const target = editTargetOf(sequence, focus);
      if (target) sequenceActions.edit(nodeId, target);
      return done();
    }
    case 'Tab':
      if (event.shiftKey || !ui.continuationsEnabled) return false;
      return acceptGhost(nodeId, sequence, focus) ? done() : false;
    case ']':
    case '[': {
      const offers = nextFor(sequence, focus);
      if (offers.length < 2 || !ui.continuationsEnabled) return offers.length > 0 ? done() : false;
      ui.setSequenceGhost((ui.sequenceGhost + (event.key === ']' ? 1 : offers.length - 1)) % offers.length);
      return done();
    }
    case 'p':
    case 'P': {
      const at = focus.kind === 'participant' ? sequence.participants.findIndex((participant) => participant.id === focus.ids[focus.ids.length - 1]) + 1 : sequence.participants.length;
      sequenceActions.addDefaultParticipant(nodeId, at);
      return done();
    }
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight':
      if (event.altKey) travel(nodeId, sequence, focus, event.key, event.shiftKey);
      else move(nodeId, sequence, focus, event.key);
      return done();
    default:
      return false;
  }
}
