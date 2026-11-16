/**
 * What is selected inside a sequence, and how the selection moves.
 *
 * A sequence is one shape on the canvas, so the canvas's own selection can only say "this
 * sequence". Which message, which participant, which branch is said here — plain data, checked
 * against the sequence it names, so it can be kept in the transient UI state and never outlive
 * what it points at.
 */
import { findItem, findOperand, itemsAt, slotOf, walkItems } from '../document/sequenceModel';
import type { DraftSequence, SeqItem } from '../document/types';

export interface SequenceFocus {
  nodeId: string;
  kind: 'participant' | 'item' | 'operand' | 'group';
  /** One or more of that kind. Several items are always neighbours in one list, in order. */
  ids: string[];
  /**
   * Selected by being made, not by being picked: a message just drawn, a participant just named.
   * It is selected — the keyboard acts on it — but no inspector opens over the place the next
   * message is about to be drawn. Picking it, like anything else, opens one. The same idea as a
   * connector just drawn on the canvas (`uiStore.quietEdgeId`).
   */
  quiet?: boolean;
}

export type SequenceEditTarget =
  | { kind: 'participant'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'guard'; id: string }
  | { kind: 'reference'; id: string }
  | { kind: 'group'; id: string };

function exists(sequence: DraftSequence, kind: SequenceFocus['kind'], id: string): boolean {
  if (kind === 'participant') return sequence.participants.some((participant) => participant.id === id);
  if (kind === 'group') return sequence.groups?.some((group) => group.id === id) ?? false;
  if (kind === 'operand') return findOperand(sequence, id) !== null;
  return findItem(sequence, id) !== null;
}

/**
 * A field open inside a sequence. `fresh` names the step being made when the thing was created a
 * moment ago and is now being given its words: making it and naming it are then one undo step, not
 * a message followed by a label.
 */
export interface SequenceEdit {
  nodeId: string;
  target: SequenceEditTarget;
  fresh?: string;
}

/** What is selected, said in a few words: for a screen reader, which cannot see the ring. */
export function describeSequenceFocus(sequence: DraftSequence, kind: SequenceFocus['kind'], ids: readonly string[]): string {
  const nameOf = (participantId: string): string => sequence.participants.find((participant) => participant.id === participantId)?.name.trim() || 'unnamed participant';
  if (ids.length === 0) return '';
  if (kind === 'participant') return ids.length > 1 ? `${ids.length} participants selected` : `${nameOf(ids[0]!)}, participant`;
  if (kind === 'group') return `${sequence.groups?.find((group) => group.id === ids[0])?.name.trim() || 'Unnamed'}, group of participants`;
  if (kind === 'operand') {
    const found = findOperand(sequence, ids[0]!);
    return found ? `Branch ${found.index + 1} of ${found.fragment.operands.length}${found.operand.guard ? `, when ${found.operand.guard}` : ''}` : '';
  }
  if (ids.length > 1) return `${ids.length} selected`;
  const item = findItem(sequence, ids[0]!)?.item;
  if (!item) return '';
  if (item.t === 'message') {
    const kindWord = item.kind === 'sync' ? 'Call' : item.kind === 'async' ? 'Asynchronous message' : item.kind === 'reply' ? 'Reply' : item.kind === 'create' ? 'Create message' : 'Destroy message';
    return `${kindWord} from ${nameOf(item.from)} to ${nameOf(item.to)}${item.label.trim() ? `: ${item.label.trim()}` : ''}`;
  }
  if (item.t === 'note') return `Note${item.text.trim() ? `: ${item.text.trim()}` : ''}`;
  return item.operator === 'ref' ? `Reference${item.label ? ` to ${item.label}` : ''}` : `${item.operator} fragment, ${item.operands.length} ${item.operands.length === 1 ? 'branch' : 'branches'}`;
}

/** `focus` with whatever is gone left out; null when nothing is left. The same object when all of it is still there. */
export function liveSequenceFocus(sequence: DraftSequence, focus: SequenceFocus): SequenceFocus | null {
  const ids = focus.ids.filter((id) => exists(sequence, focus.kind, id));
  if (ids.length === focus.ids.length) return focus;
  return ids.length > 0 ? { ...focus, ids } : null;
}

export function sequenceEditStillThere(sequence: DraftSequence, target: SequenceEditTarget): boolean {
  switch (target.kind) {
    case 'participant':
      return exists(sequence, 'participant', target.id);
    case 'group':
      return exists(sequence, 'group', target.id);
    case 'guard':
      return exists(sequence, 'operand', target.id);
    default:
      return exists(sequence, 'item', target.id);
  }
}

/**
 * The items a shift-click reaches from `anchorId` to `toId`: every item between them when they
 * share a list, since a fragment can only be made of a stretch. Just `toId` when they do not.
 */
export function itemRange(sequence: DraftSequence, anchorId: string, toId: string): string[] {
  const from = slotOf(sequence, anchorId);
  const to = slotOf(sequence, toId);
  if (!from || !to || from.operandId !== to.operandId) return [toId];
  const list = itemsAt(sequence, from.operandId) ?? [];
  return list.slice(Math.min(from.index, to.index), Math.max(from.index, to.index) + 1).map((item) => item.id);
}

/** Every item in the order it is read: a fragment, then what it holds. What ⌥↑ and ⌥↓ step through. */
export function readingOrder(sequence: DraftSequence): SeqItem[] {
  const order: SeqItem[] = [];
  walkItems(sequence.items, (item) => {
    order.push(item);
  });
  return order;
}

/** The item `step` places before or after `id` in reading order, or null at either end. */
export function neighbourItem(sequence: DraftSequence, id: string, step: 1 | -1): string | null {
  const order = readingOrder(sequence);
  const at = order.findIndex((item) => item.id === id);
  return at < 0 ? null : (order[at + step]?.id ?? null);
}

/** The participant `step` places to the left or right of `id`, or null at either end. */
export function neighbourParticipant(sequence: DraftSequence, id: string, step: 1 | -1): string | null {
  const at = sequence.participants.findIndex((participant) => participant.id === id);
  return at < 0 ? null : (sequence.participants[at + step]?.id ?? null);
}
