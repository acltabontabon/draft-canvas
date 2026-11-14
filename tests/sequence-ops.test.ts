import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/document/limits';
import { findItem, findOperand, messagesOf, slotOf } from '../src/document/sequenceModel';
import {
  addOperand,
  addParticipant,
  createFragment,
  createMessage,
  createNote,
  createReply,
  dropParticipantLinks,
  duplicateItem,
  groupParticipants,
  insertItem,
  leaveGroup,
  moveItem,
  moveOperand,
  moveParticipant,
  removeItems,
  removeOperand,
  removeParticipant,
  reverseMessage,
  setFragmentOperator,
  setGuard,
  setMessageKind,
  ungroupParticipants,
  unwrapFragment,
  updateMessage,
  updateParticipant,
  updateSequence,
  wrapItems,
} from '../src/document/sequenceOps';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes, removeElements } from '../src/document/operations';
import type { DraftSequence, SeqFragment, SeqItem, SeqMessage, SeqParticipant } from '../src/document/types';

const participant = (id: string, extra: Partial<SeqParticipant> = {}): SeqParticipant => ({
  id,
  name: id.toUpperCase(),
  type: 'service',
  serviceKind: 'generic',
  ...extra,
});

const call = (id: string, from: string, to: string, label = id): SeqMessage => createMessage({ id, from, to, label });

/** Client → API → DB, with a call each way and their replies. */
function shop(): DraftSequence {
  const items: SeqItem[] = [
    call('m1', 'client', 'api', 'POST /orders'),
    call('m2', 'api', 'db', 'insert order'),
    createReply(call('m2', 'api', 'db'), 'ok'),
    createReply(call('m1', 'client', 'api'), '201'),
  ];
  items[2] = { ...items[2]!, id: 'r2' };
  items[3] = { ...items[3]!, id: 'r1' };
  return { participants: [participant('client', { type: 'actor', actorKind: 'human' }), participant('api'), participant('db', { type: 'database', databaseKind: 'sql' })], items };
}

const labels = (sequence: DraftSequence) => messagesOf(sequence).map((message) => message.id);

describe('participants', () => {
  it('adds a lifeline where asked and refuses a taken id', () => {
    const start = shop();
    const next = addParticipant(start, participant('cache'), 2);
    expect(next.participants.map((p) => p.id)).toEqual(['client', 'api', 'cache', 'db']);
    expect(addParticipant(next, participant('cache'))).toBe(next);
  });

  it('stops at the limit', () => {
    let sequence: DraftSequence = { participants: [], items: [] };
    for (let index = 0; index < LIMITS.maxSequenceParticipants + 5; index += 1) sequence = addParticipant(sequence, participant(`p${index}`));
    expect(sequence.participants).toHaveLength(LIMITS.maxSequenceParticipants);
  });

  it('retyping drops the old kind and takes the new default', () => {
    const next = updateParticipant(shop(), 'api', { type: 'queue' });
    const api = next.participants.find((p) => p.id === 'api')!;
    expect(api).toMatchObject({ type: 'queue', queueKind: 'queue' });
    expect(api.serviceKind).toBeUndefined();
  });

  it('an unchanged participant leaves the sequence untouched', () => {
    const start = shop();
    expect(updateParticipant(start, 'api', { name: 'API' })).toBe(start);
  });

  it('removing a lifeline removes its messages and the replies to them', () => {
    const next = removeParticipant(shop(), 'db');
    expect(next.participants.map((p) => p.id)).toEqual(['client', 'api']);
    expect(labels(next)).toEqual(['m1', 'r1']);
  });

  it('a note over two keeps the one that is left, and goes with its last', () => {
    const withNote = insertItem(shop(), createNote({ id: 'n1', over: ['api', 'db'], text: 'slow' }), { operandId: null, index: 0 });
    const once = removeParticipant(withNote, 'db');
    expect(findItem(once, 'n1')!.item).toMatchObject({ over: ['api'] });
    expect(findItem(removeParticipant(once, 'api'), 'n1')).toBeNull();
  });

  it('reorders by final position and keeps untouched items by identity', () => {
    const start = shop();
    const next = moveParticipant(start, 'db', 0);
    expect(next.participants.map((p) => p.id)).toEqual(['db', 'client', 'api']);
    expect(next.items).toBe(start.items);
    expect(moveParticipant(start, 'db', 2)).toBe(start);
  });
});

describe('participant groups', () => {
  it('draws the chosen together where the first stood', () => {
    const start = addParticipant(shop(), participant('cache'));
    const next = groupParticipants(start, ['api', 'cache'], { id: 'g1', name: 'Backend' });
    expect(next.participants.map((p) => p.id)).toEqual(['client', 'api', 'cache', 'db']);
    expect(next.groups).toEqual([{ id: 'g1', name: 'Backend', participantIds: ['api', 'cache'] }]);
  });

  it('a lifeline dropped between two members joins them; moved away, it leaves', () => {
    const four = addParticipant(shop(), participant('mail'));
    const grouped = groupParticipants(four, ['api', 'db'], { id: 'g1', name: 'Backend' });
    const joined = moveParticipant(grouped, 'client', 1);
    expect(joined.participants.map((p) => p.id)).toEqual(['api', 'client', 'db', 'mail']);
    expect(joined.groups![0]!.participantIds).toEqual(['api', 'client', 'db']);
    // To the group's own edge is a reorder inside it; past a non-member is leaving.
    expect(moveParticipant(joined, 'client', 0).groups![0]!.participantIds).toEqual(['client', 'api', 'db']);
    const left = moveParticipant(joined, 'client', 3);
    expect(left.participants.map((p) => p.id)).toEqual(['api', 'db', 'mail', 'client']);
    expect(left.groups![0]!.participantIds).toEqual(['api', 'db']);
  });

  it('a member can be taken out where there is nowhere to drag it', () => {
    const all = groupParticipants(shop(), ['client', 'api', 'db'], { id: 'g1' });
    const next = leaveGroup(all, 'api');
    expect(next.participants.map((p) => p.id)).toEqual(['api', 'client', 'db']);
    expect(next.groups![0]!.participantIds).toEqual(['client', 'db']);
    expect(leaveGroup(next, 'api')).toBe(next);
  });

  it('a new group does not split one it is not part of', () => {
    const four = addParticipant(shop(), participant('cache'));
    const backend = groupParticipants(four, ['api', 'db', 'cache'], { id: 'g1' });
    const next = groupParticipants(backend, ['db', 'client'], { id: 'g2' });
    const order = next.participants.map((p) => p.id);
    for (const group of next.groups!) {
      const at = group.participantIds.map((id) => order.indexOf(id));
      expect(at).toEqual(at.map((_, index) => at[0]! + index));
    }
  });

  it('ungrouping leaves everyone where they stand', () => {
    const grouped = groupParticipants(shop(), ['api', 'db'], { id: 'g1' });
    const next = ungroupParticipants(grouped, 'g1');
    expect(next.groups).toBeUndefined();
    expect(next.participants).toBe(grouped.participants);
  });
});

describe('messages', () => {
  it('a call starts work and its reply ends it — written once, at creation', () => {
    const request = call('m', 'a', 'b');
    expect(request.activate).toBe(true);
    expect(createReply(request)).toMatchObject({ kind: 'reply', from: 'b', to: 'a', replyTo: 'm', deactivate: true });
    expect(createMessage({ from: 'a', to: 'b', kind: 'async' }).activate).toBeUndefined();
  });

  it('refuses a message to a participant that is not there', () => {
    const start = shop();
    expect(insertItem(start, call('x', 'api', 'ghost'), { operandId: null, index: 0 })).toBe(start);
    expect(updateMessage(start, 'm1', { to: 'ghost' })).toBe(start);
  });

  it('a chosen kind takes that kind’s settings and is marked as chosen', () => {
    const next = setMessageKind(shop(), 'm2', 'async');
    const message = findItem(next, 'm2')!.item as SeqMessage;
    expect(message).toMatchObject({ kind: 'async', kindOrigin: 'explicit' });
    expect(message.activate).toBeUndefined();
  });

  it('turns a message round', () => {
    expect(findItem(reverseMessage(shop(), 'm2'), 'm2')!.item).toMatchObject({ from: 'db', to: 'api' });
  });

  it('typing a label and erasing it gives back equal content', () => {
    const start = shop();
    const typed = updateMessage(start, 'm1', { label: 'POST /orders!' });
    const erased = updateMessage(typed, 'm1', { label: 'POST /orders' });
    expect(erased).toEqual(start);
    expect(erased.items[1]).toBe(start.items[1]);
  });

  it('deleting a call leaves its reply answering nothing in particular', () => {
    const next = removeItems(shop(), ['m2']);
    expect((findItem(next, 'r2')!.item as SeqMessage).replyTo).toBeUndefined();
  });

  it('a copied reply still answers the original; copied with its call, the copy', () => {
    const alone = duplicateItem(shop(), 'r2');
    expect((findItem(alone.sequence, alone.id!)!.item as SeqMessage).replyTo).toBe('m2');

    const wrapped = wrapItems(shop(), ['m2', 'r2'], { id: 'f1', operator: 'opt' });
    const copied = duplicateItem(wrapped, 'f1');
    const copy = findItem(copied.sequence, copied.id!)!.item as SeqFragment;
    const [copiedCall, copiedReply] = copy.operands[0]!.items as SeqMessage[];
    expect(copiedCall!.id).not.toBe('m2');
    expect(copiedReply!.replyTo).toBe(copiedCall!.id);
  });
});

describe('moving', () => {
  it('moves within a list, counting the list as it stands', () => {
    expect(labels(moveItem(shop(), 'm2', { operandId: null, index: 4 }))).toEqual(['m1', 'r2', 'r1', 'm2']);
    expect(labels(moveItem(shop(), 'r1', { operandId: null, index: 0 }))).toEqual(['r1', 'm1', 'm2', 'r2']);
  });

  it('a move to where it already is changes nothing', () => {
    const start = shop();
    expect(moveItem(start, 'm2', { operandId: null, index: 1 })).toBe(start);
    expect(moveItem(start, 'm2', { operandId: null, index: 2 })).toBe(start);
  });

  it('moves into a branch and out again', () => {
    const wrapped = wrapItems(shop(), ['m2'], { id: 'f1', operator: 'opt', guard: 'in stock' });
    const branch = (findItem(wrapped, 'f1')!.item as SeqFragment).operands[0]!.id;
    const into = moveItem(wrapped, 'r2', { operandId: branch, index: 1 });
    expect(slotOf(into, 'r2')).toEqual({ operandId: branch, index: 1 });
    const out = moveItem(into, 'm2', { operandId: null, index: 0 });
    expect(slotOf(out, 'm2')).toEqual({ operandId: null, index: 0 });
  });

  it('a fragment cannot go inside itself', () => {
    const wrapped = wrapItems(shop(), ['m2', 'r2'], { id: 'f1', operator: 'loop' });
    const inner = wrapItems(wrapped, ['m2'], { id: 'f2', operator: 'opt' });
    const innerBranch = (findItem(inner, 'f2')!.item as SeqFragment).operands[0]!.id;
    expect(moveItem(inner, 'f1', { operandId: innerBranch, index: 0 })).toBe(inner);
  });
});

describe('fragments', () => {
  it('wraps a stretch, taking what lies between the chosen', () => {
    const next = wrapItems(shop(), ['m1', 'r2'], { id: 'f1', operator: 'alt', guard: 'valid' });
    const fragment = next.items[0] as SeqFragment;
    expect(next.items).toHaveLength(2);
    expect(fragment.operands[0]).toMatchObject({ guard: 'valid' });
    expect(fragment.operands[0]!.items.map((item) => item.id)).toEqual(['m1', 'm2', 'r2']);
  });

  it('will not wrap items from different lists', () => {
    const wrapped = wrapItems(shop(), ['m2'], { id: 'f1', operator: 'opt' });
    expect(wrapItems(wrapped, ['m2', 'r2'], { id: 'f2', operator: 'loop' })).toBe(wrapped);
  });

  it('unwrapping keeps every message, in order', () => {
    const start = shop();
    const wrapped = wrapItems(start, ['m2', 'r2'], { id: 'f1', operator: 'opt' });
    expect(unwrapFragment(wrapped, 'f1').items).toEqual(start.items);
  });

  it('adds branches to an alt and not to a loop', () => {
    const alt = wrapItems(shop(), ['m2'], { id: 'f1', operator: 'alt' });
    const two = addOperand(alt, 'f1', { id: 'o2', guard: 'else' });
    expect((two.items[1] as SeqFragment).operands.map((branch) => branch.guard)).toEqual([undefined, 'else']);
    const loop = setFragmentOperator(alt, 'f1', 'loop');
    expect(addOperand(loop, 'f1', { id: 'o3' })).toBe(loop);
  });

  it('removing a branch hands its messages to its neighbour', () => {
    const alt = addOperand(wrapItems(shop(), ['m2'], { id: 'f1', operator: 'alt' }), 'f1', { id: 'o2' });
    const filled = moveItem(alt, 'r2', { operandId: 'o2', index: 0 });
    const merged = removeOperand(filled, 'o2');
    const fragment = findItem(merged, 'f1')!.item as SeqFragment;
    expect(fragment.operands).toHaveLength(1);
    expect(fragment.operands[0]!.items.map((item) => item.id)).toEqual(['m2', 'r2']);
    expect(findItem(removeOperand(filled, 'o2', true), 'r2')).toBeNull();
  });

  it('going from two branches to a one-branch kind keeps every message', () => {
    const alt = addOperand(wrapItems(shop(), ['m2'], { id: 'f1', operator: 'alt' }), 'f1', { id: 'o2' });
    const filled = moveItem(alt, 'r2', { operandId: 'o2', index: 0 });
    const opt = setFragmentOperator(filled, 'f1', 'opt');
    const fragment = findItem(opt, 'f1')!.item as SeqFragment;
    expect(fragment.operands).toHaveLength(1);
    expect(fragment.operands[0]!.items.map((item) => item.id)).toEqual(['m2', 'r2']);
  });

  it('only an empty fragment becomes a reference', () => {
    const wrapped = wrapItems(shop(), ['m2'], { id: 'f1', operator: 'opt' });
    expect(setFragmentOperator(wrapped, 'f1', 'ref')).toBe(wrapped);
    const empty = insertItem(shop(), createFragment({ id: 'f2', operator: 'opt' }), { operandId: null, index: 0 });
    expect(findItem(setFragmentOperator(empty, 'f2', 'ref'), 'f2')!.item).toMatchObject({ operator: 'ref', operands: [] });
  });

  it('reorders branches and edits a guard', () => {
    const alt = addOperand(wrapItems(shop(), ['m2'], { id: 'f1', operator: 'alt', guard: 'ok' }), 'f1', { id: 'o2', guard: 'else' });
    const swapped = moveOperand(alt, 'o2', 0);
    expect((findItem(swapped, 'f1')!.item as SeqFragment).operands.map((branch) => branch.guard)).toEqual(['else', 'ok']);
    expect(findOperand(setGuard(swapped, 'o2', '  timed   out '), 'o2')!.operand.guard).toBe('timed out');
    expect(findOperand(setGuard(swapped, 'o2', ''), 'o2')!.operand.guard).toBeUndefined();
  });

  it('refuses nesting past the limit', () => {
    let sequence = shop();
    for (let depth = 0; depth < LIMITS.maxSequenceDepth; depth += 1) sequence = wrapItems(sequence, ['m2'], { id: `f${depth}`, operator: 'opt' });
    expect(wrapItems(sequence, ['m2'], { id: 'too-deep', operator: 'opt' })).toBe(sequence);
  });
});

describe('in a document', () => {
  it('edits one sequence node and nothing else', () => {
    const node = { ...createNode({ type: 'sequence', x: 0, y: 0 }), sequence: shop() };
    const other = createNode({ type: 'service', x: 500, y: 0 });
    const doc = addNodes(createDocument(), [node, other]);
    const next = updateSequence(doc, node.id, (sequence) => updateMessage(sequence, 'm1', { label: 'PUT /orders' }));
    expect(next.nodes[1]).toBe(doc.nodes[1]);
    expect(next.nodes[0]!.sequence!.items[1]).toBe(doc.nodes[0]!.sequence!.items[1]);
    expect(updateSequence(doc, node.id, (sequence) => sequence)).toBe(doc);
    expect(updateSequence(doc, other.id, () => shop())).toBe(doc);
  });

  it('deleting a shape keeps the participant that stood for it, unlinked', () => {
    const shape = createNode({ type: 'service', x: 500, y: 0, text: 'API' });
    const sequence = updateParticipant(shop(), 'api', { ref: shape.id });
    const node = { ...createNode({ type: 'sequence', x: 0, y: 0 }), sequence };
    const doc = addNodes(createDocument(), [node, shape]);
    const next = removeElements(doc, [shape.id]);
    expect(next.nodes[0]!.sequence!.participants.find((p) => p.id === 'api')!.ref).toBeUndefined();
    expect(dropParticipantLinks(doc, new Set(['nobody']))).toBe(doc);
  });
});
