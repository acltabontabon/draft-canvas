/**
 * Reading a sequence: where things are in it, and what they touch.
 *
 * Everything that works on a `DraftSequence` — the operations, the checks, the layout, the export —
 * walks it through here, so "document order" and "inside which branch" mean one thing everywhere.
 */
import type {
  DraftNode,
  DraftSequence,
  SeqFragment,
  SeqItem,
  SeqMessage,
  SeqOperand,
  SeqOperator,
  SeqParticipant,
} from './types';
import { SEQ_BRANCHING_OPERATORS } from './types';

export const EMPTY_SEQUENCE: DraftSequence = Object.freeze({
  participants: Object.freeze([]) as unknown as SeqParticipant[],
  items: Object.freeze([]) as unknown as SeqItem[],
});

/** A sequence node's content. A node without one (a file cut short, a test's bare node) is empty. */
export function sequenceOf(node: Pick<DraftNode, 'sequence'>): DraftSequence {
  return node.sequence ?? EMPTY_SEQUENCE;
}

/**
 * A place something can go: before `index` in the top level (`operandId` null) or in one branch.
 * `index` equal to the list's length is "at the end".
 */
export interface SeqSlot {
  operandId: string | null;
  index: number;
}

export interface SeqVisit {
  /** The branch the item is in; null at the top level. */
  operand: SeqOperand | null;
  /** The fragment that branch belongs to; null at the top level. */
  fragment: SeqFragment | null;
  /** Fragments around the item: 0 at the top level. */
  depth: number;
  index: number;
}

/** Every item in document order — a fragment before what it holds. Return `false` to stop. */
export function walkItems(
  items: readonly SeqItem[],
  visit: (item: SeqItem, at: SeqVisit) => boolean | void,
  operand: SeqOperand | null = null,
  fragment: SeqFragment | null = null,
  depth = 0,
): boolean {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (visit(item, { operand, fragment, depth, index }) === false) return false;
    if (item.t !== 'fragment') continue;
    for (const branch of item.operands) {
      if (!walkItems(branch.items, visit, branch, item, depth + 1)) return false;
    }
  }
  return true;
}

/** How many messages, notes and fragments a sequence holds, at every depth. */
export function countItems(items: readonly SeqItem[]): number {
  let count = 0;
  walkItems(items, () => {
    count += 1;
  });
  return count;
}

/** Every message in document order. */
export function messagesOf(sequence: DraftSequence): SeqMessage[] {
  const messages: SeqMessage[] = [];
  walkItems(sequence.items, (item) => {
    if (item.t === 'message') messages.push(item);
  });
  return messages;
}

export function findItem(sequence: DraftSequence, id: string): { item: SeqItem; at: SeqVisit } | null {
  let found: { item: SeqItem; at: SeqVisit } | null = null;
  walkItems(sequence.items, (item, at) => {
    if (item.id !== id) return;
    found = { item, at };
    return false;
  });
  return found;
}

export function findOperand(
  sequence: DraftSequence,
  operandId: string,
): { operand: SeqOperand; fragment: SeqFragment; index: number; depth: number } | null {
  let found: { operand: SeqOperand; fragment: SeqFragment; index: number; depth: number } | null = null;
  walkItems(sequence.items, (item, at) => {
    if (item.t !== 'fragment') return;
    const index = item.operands.findIndex((branch) => branch.id === operandId);
    if (index < 0) return;
    found = { operand: item.operands[index]!, fragment: item, index, depth: at.depth + 1 };
    return false;
  });
  return found;
}

/** The list a slot points into, or null when its branch is gone. */
export function itemsAt(sequence: DraftSequence, operandId: string | null): readonly SeqItem[] | null {
  if (operandId === null) return sequence.items;
  return findOperand(sequence, operandId)?.operand.items ?? null;
}

/** Where an item is. */
export function slotOf(sequence: DraftSequence, itemId: string): SeqSlot | null {
  const found = findItem(sequence, itemId);
  return found ? { operandId: found.at.operand?.id ?? null, index: found.at.index } : null;
}

/** How many fragments deep an item reaches below itself: 0 for a message, 1 for a flat fragment. */
export function heightOf(item: SeqItem): number {
  if (item.t !== 'fragment') return 0;
  let deepest = 0;
  for (const branch of item.operands) for (const child of branch.items) deepest = Math.max(deepest, heightOf(child));
  return deepest + 1;
}

/** The participants an item involves, itself and everything inside it. */
export function participantsIn(item: SeqItem, into: Set<string> = new Set()): Set<string> {
  if (item.t === 'message') {
    into.add(item.from);
    into.add(item.to);
  } else if (item.t === 'note') {
    for (const id of item.over) into.add(id);
  } else {
    for (const id of item.covers ?? []) into.add(id);
    for (const branch of item.operands) for (const child of branch.items) participantsIn(child, into);
  }
  return into;
}

/** Whether `inner` is `outer` or somewhere inside it. */
export function contains(outer: SeqItem, innerId: string): boolean {
  if (outer.id === innerId) return true;
  if (outer.t !== 'fragment') return false;
  return outer.operands.some((branch) => branch.items.some((child) => contains(child, innerId)));
}

export const isBranching = (operator: SeqOperator): boolean => SEQ_BRANCHING_OPERATORS.includes(operator);

export function participantIndex(sequence: DraftSequence, id: string): number {
  return sequence.participants.findIndex((participant) => participant.id === id);
}

/** The group a participant is drawn in, if any. */
export function groupOf(sequence: DraftSequence, participantId: string) {
  return sequence.groups?.find((group) => group.participantIds.includes(participantId));
}
