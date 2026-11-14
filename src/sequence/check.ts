/**
 * What a sequence says that cannot be so: a participant used after it was destroyed, a reply ahead
 * of its call, work ended that never began.
 *
 * Findings are shown, explained and offered a fix; nothing here changes a sequence, and no edit is
 * refused for causing one. A diagram that is merely unfinished — a call with no reply yet, an empty
 * branch — is not wrong and produces nothing.
 *
 * "Before" and "after" are read as the diagram runs: two messages in different branches of the same
 * `alt` or `par` are never one after the other, so destroying a participant in one branch and using
 * it in the next is fine.
 */
import { findItem, isBranching, walkItems, type SeqSlot } from '../document/sequenceModel';
import { moveItem, updateMessage } from '../document/sequenceOps';
import type { DraftSequence, SeqItem, SeqMessage } from '../document/types';
import { executionsOf } from './executions';

export type FindingKind =
  | 'before-create'
  | 'created-twice'
  | 'creates-itself'
  | 'after-destroy'
  | 'destroyed-twice'
  | 'reply-without-call'
  | 'reply-before-call'
  | 'reply-wrong-way'
  | 'answered-twice'
  | 'nothing-to-end';

export interface SequenceFinding {
  kind: FindingKind;
  /** The messages it is about; the first is where it is marked. */
  itemIds: string[];
  /** One plain sentence. */
  message: string;
  /** A change that would settle it, for the person to choose. */
  fix?: { label: string; apply: (sequence: DraftSequence) => DraftSequence };
}

interface Placed {
  message: SeqMessage;
  order: number;
  /** The branch taken at each branching fragment around it, outermost first. */
  branches: readonly { fragmentId: string; operandId: string }[];
}

/** Two messages that can never both happen in one run, or have no order between them. */
function apart(a: Placed, b: Placed): boolean {
  const shared = Math.min(a.branches.length, b.branches.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a.branches[index]!;
    const right = b.branches[index]!;
    if (left.fragmentId !== right.fragmentId) return false;
    if (left.operandId !== right.operandId) return true;
  }
  return false;
}

function placedMessages(sequence: DraftSequence): Placed[] {
  const placed: Placed[] = [];
  const visit = (items: readonly SeqItem[], branches: Placed['branches']) => {
    for (const item of items) {
      if (item.t === 'message') placed.push({ message: item, order: placed.length, branches });
      else if (item.t === 'fragment') {
        for (const branch of item.operands) {
          visit(branch.items, isBranching(item.operator) ? [...branches, { fragmentId: item.id, operandId: branch.id }] : branches);
        }
      }
    }
  };
  visit(sequence.items, []);
  return placed;
}

const findings = new WeakMap<DraftSequence, SequenceFinding[]>();

export function checkSequence(sequence: DraftSequence): SequenceFinding[] {
  const cached = findings.get(sequence);
  if (cached) return cached;
  const found: SequenceFinding[] = [];
  const placed = placedMessages(sequence);
  const byId = new Map(placed.map((entry) => [entry.message.id, entry]));
  const nameOf = (participantId: string): string =>
    sequence.participants.find((participant) => participant.id === participantId)?.name.trim() || 'This participant';

  // Lifetimes.
  for (const participant of sequence.participants) {
    const involving = placed.filter((entry) => entry.message.from === participant.id || entry.message.to === participant.id);
    const creates = involving.filter((entry) => entry.message.kind === 'create' && entry.message.to === participant.id);
    const destroys = involving.filter((entry) => entry.message.kind === 'destroy' && entry.message.to === participant.id);
    const name = nameOf(participant.id);

    for (const create of creates) {
      if (create.message.from === create.message.to) {
        found.push({ kind: 'creates-itself', itemIds: [create.message.id], message: `${name} cannot create itself.` });
        continue;
      }
      if (involving.some((entry) => entry.order < create.order && !apart(entry, create) && entry.message.kind !== 'create')) {
        found.push({
          kind: 'before-create',
          itemIds: [create.message.id],
          message: `${name} already takes part above the point where it is created.`,
        });
      }
    }
    const repeatedCreate = creates.find((entry, index) => creates.slice(0, index).some((earlier) => !apart(earlier, entry)));
    if (repeatedCreate) {
      found.push({ kind: 'created-twice', itemIds: [repeatedCreate.message.id], message: `${name} is created more than once.` });
    }
    const repeatedDestroy = destroys.find((entry, index) => destroys.slice(0, index).some((earlier) => !apart(earlier, entry)));
    if (repeatedDestroy) {
      found.push({ kind: 'destroyed-twice', itemIds: [repeatedDestroy.message.id], message: `${name} is destroyed more than once.` });
    }
    const first = destroys[0];
    if (first) {
      const late = involving.filter((entry) => entry.order > first.order && !apart(entry, first) && entry.message.kind !== 'destroy');
      if (late.length > 0) {
        found.push({
          kind: 'after-destroy',
          itemIds: late.map((entry) => entry.message.id),
          message: `${name} takes part after it is destroyed.`,
        });
      }
    }
  }

  // Replies.
  const answered = new Map<string, Placed[]>();
  for (const reply of placed) {
    if (reply.message.kind !== 'reply') continue;
    const call = reply.message.replyTo ? byId.get(reply.message.replyTo) : undefined;
    if (!call) {
      found.push({ kind: 'reply-without-call', itemIds: [reply.message.id], message: 'This reply has no matching call.' });
      continue;
    }
    if (call.order > reply.order) {
      found.push({
        kind: 'reply-before-call',
        itemIds: [reply.message.id, call.message.id],
        message: 'This reply comes before the call it answers.',
        fix: { label: 'Move it after the call', apply: (current) => moveAfter(current, reply.message.id, call.message.id) },
      });
    }
    if (call.message.to !== reply.message.from || call.message.from !== reply.message.to) {
      found.push({
        kind: 'reply-wrong-way',
        itemIds: [reply.message.id, call.message.id],
        message: 'This reply does not go back to whoever made the call.',
        fix: {
          label: 'Send it back to the caller',
          apply: (current) => updateMessage(current, reply.message.id, { from: call.message.to, to: call.message.from }),
        },
      });
    }
    const earlier = answered.get(call.message.id) ?? [];
    if (earlier.some((other) => !apart(other, reply))) {
      found.push({
        kind: 'answered-twice',
        itemIds: [reply.message.id, call.message.id],
        message: 'This call is already answered above.',
        fix: { label: 'Make this a reply to nothing in particular', apply: (current) => updateMessage(current, reply.message.id, { replyTo: undefined }) },
      });
    }
    answered.set(call.message.id, [...earlier, reply]);
  }

  // Work ended that was not running.
  for (const id of executionsOf(sequence).unmatched) {
    const entry = byId.get(id);
    if (!entry) continue;
    found.push({
      kind: 'nothing-to-end',
      itemIds: [id],
      message: `${nameOf(entry.message.from)} has no work running to end here.`,
      fix: { label: 'Keep the message, end nothing', apply: (current) => updateMessage(current, id, { deactivate: undefined }) },
    });
  }

  findings.set(sequence, found);
  return found;
}

function moveAfter(sequence: DraftSequence, id: string, afterId: string): DraftSequence {
  const anchor = findItem(sequence, afterId);
  if (!anchor) return sequence;
  return moveItem(sequence, id, { operandId: anchor.at.operand?.id ?? null, index: anchor.at.index + 1 });
}

/** The findings about one item, or about anything inside it. */
export function findingsFor(sequence: DraftSequence, itemId: string): SequenceFinding[] {
  const found = findItem(sequence, itemId);
  if (!found) return [];
  const inside = new Set<string>();
  walkItems([found.item], (item) => {
    inside.add(item.id);
  });
  return checkSequence(sequence).filter((finding) => finding.itemIds.some((id) => inside.has(id)));
}

const keyOf = (finding: SequenceFinding): string => `${finding.kind}:${finding.itemIds.join(',')}`;

/**
 * Why an item should not be moved to a slot, in a sentence — or null when it may. A move is only
 * objected to for what it would newly make wrong; one that leaves an existing problem as it was,
 * or mends it, is fine.
 */
export function moveProblem(sequence: DraftSequence, itemId: string, slot: SeqSlot): string | null {
  const moved = moveItem(sequence, itemId, slot);
  if (moved === sequence) return null;
  const before = new Set(checkSequence(sequence).map(keyOf));
  const caused = checkSequence(moved).find((finding) => !before.has(keyOf(finding)));
  return caused ? caused.message : null;
}
