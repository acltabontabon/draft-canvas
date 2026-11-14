import { describe, expect, it } from 'vitest';
import { addOperand, createMessage, createReply, insertItem, moveItem, wrapItems } from '../src/document/sequenceOps';
import type { DraftSequence, SeqItem, SeqMessage, SeqParticipant } from '../src/document/types';
import { checkSequence, moveProblem } from '../src/sequence/check';
import { executionsOf } from '../src/sequence/executions';

const who = (id: string): SeqParticipant => ({ id, name: id, type: 'service', serviceKind: 'generic' });
const call = (id: string, from: string, to: string): SeqMessage => createMessage({ id, from, to, label: id });
const reply = (id: string, to: SeqMessage): SeqMessage => ({ ...createReply(to, id), id });
const sequence = (items: SeqItem[], participants = ['a', 'b', 'c']): DraftSequence => ({ participants: participants.map(who), items });

const kinds = (subject: DraftSequence) => checkSequence(subject).map((finding) => finding.kind);

describe('activations', () => {
  it('a call and its reply make one bar on the receiver', () => {
    const m1 = call('m1', 'a', 'b');
    expect(executionsOf(sequence([m1, reply('r1', m1)])).executions).toEqual([
      { participantId: 'b', startId: 'm1', endId: 'r1', ends: 'at', depth: 0 },
    ]);
  });

  it('nests: the receiver calls on while it works', () => {
    const m1 = call('m1', 'a', 'b');
    const m2 = call('m2', 'b', 'c');
    const plan = executionsOf(sequence([m1, m2, reply('r2', m2), reply('r1', m1)]));
    expect(plan.executions.map((bar) => [bar.participantId, bar.startId, bar.endId, bar.depth])).toEqual([
      ['b', 'm1', 'r1', 0],
      ['c', 'm2', 'r2', 0],
    ]);
  });

  it('a second call into a working participant stacks a second bar', () => {
    const m1 = call('m1', 'a', 'b');
    const m2 = call('m2', 'c', 'b');
    const plan = executionsOf(sequence([m1, m2, reply('r2', m2), reply('r1', m1)]));
    expect(plan.executions.map((bar) => [bar.startId, bar.depth])).toEqual([
      ['m1', 0],
      ['m2', 1],
    ]);
  });

  it('a call never answered runs to the last thing its receiver does', () => {
    const m1 = call('m1', 'a', 'b');
    const m2 = createMessage({ id: 'm2', from: 'b', to: 'c', kind: 'async' });
    expect(executionsOf(sequence([m1, m2])).executions).toEqual([{ participantId: 'b', startId: 'm1', endId: 'm2', ends: 'after', depth: 0 }]);
    expect(checkSequence(sequence([m1, m2]))).toEqual([]);
  });

  it('a call answered in either branch of an alt is one bar, not an end with nothing to end', () => {
    const m1 = call('m1', 'a', 'b');
    const ok = reply('ok', m1);
    const failed = reply('failed', m1);
    let subject = sequence([m1, ok, failed]);
    subject = wrapItems(subject, ['ok'], { id: 'f', operator: 'alt', guard: 'valid' });
    subject = addOperand(subject, 'f', { id: 'else', guard: 'else' });
    subject = moveItem(subject, 'failed', { operandId: 'else', index: 0 });
    const plan = executionsOf(subject);
    expect(plan.unmatched).toEqual([]);
    expect(plan.executions).toEqual([{ participantId: 'b', startId: 'm1', endId: 'failed', ends: 'at', depth: 0 }]);
    expect(checkSequence(subject)).toEqual([]);
  });

  it('ending work that is not running is found, with a fix that keeps the message', () => {
    const stray: SeqMessage = { ...createMessage({ id: 'x', from: 'b', to: 'a', kind: 'reply' }) };
    const subject = sequence([stray]);
    const [finding] = checkSequence(subject);
    expect(finding).toMatchObject({ kind: 'nothing-to-end', itemIds: ['x'] });
    const fixed = finding!.fix!.apply(subject);
    expect(checkSequence(fixed)).toEqual([]);
    expect(fixed.items).toHaveLength(1);
  });
});

describe('lifetimes', () => {
  it('a participant used before it is created', () => {
    const m1 = call('m1', 'a', 'b');
    const create = createMessage({ id: 'new', from: 'a', to: 'b', kind: 'create' });
    expect(kinds(sequence([m1, create]))).toContain('before-create');
    expect(kinds(sequence([create, m1]))).toEqual([]);
  });

  it('a participant used after it is destroyed, but not in a sibling branch', () => {
    const destroy = createMessage({ id: 'end', from: 'a', to: 'b', kind: 'destroy' });
    const late = call('late', 'a', 'b');
    expect(kinds(sequence([destroy, late]))).toEqual(['after-destroy']);

    let branched = sequence([destroy, late]);
    branched = wrapItems(branched, ['end'], { id: 'f', operator: 'alt' });
    branched = addOperand(branched, 'f', { id: 'other' });
    branched = moveItem(branched, 'late', { operandId: 'other', index: 0 });
    expect(checkSequence(branched)).toEqual([]);
  });

  it('created twice, and creating itself', () => {
    const create = (id: string, from = 'a') => createMessage({ id, from, to: 'b', kind: 'create' });
    expect(kinds(sequence([create('one'), create('two')]))).toContain('created-twice');
    expect(kinds(sequence([create('self', 'b')]))).toEqual(['creates-itself']);
  });
});

describe('replies', () => {
  it('a reply ahead of its call, mended by moving it', () => {
    const m1 = call('m1', 'a', 'b');
    const subject = sequence([reply('r1', m1), m1]);
    const finding = checkSequence(subject).find((entry) => entry.kind === 'reply-before-call')!;
    expect(finding.itemIds).toEqual(['r1', 'm1']);
    expect(kinds(finding.fix!.apply(subject))).toEqual([]);
  });

  it('a reply that goes somewhere else', () => {
    const m1 = call('m1', 'a', 'b');
    const astray: SeqMessage = { ...reply('r1', m1), to: 'c' };
    const subject = sequence([m1, astray]);
    const finding = checkSequence(subject).find((entry) => entry.kind === 'reply-wrong-way')!;
    expect(checkSequence(finding.fix!.apply(subject))).toEqual([]);
  });

  it('a call left unanswered is not a problem', () => {
    expect(checkSequence(sequence([call('m1', 'a', 'b'), call('m2', 'b', 'c')]))).toEqual([]);
  });
});

describe('moving', () => {
  it('objects only to what a move would newly break', () => {
    const m1 = call('m1', 'a', 'b');
    const subject = sequence([m1, reply('r1', m1), call('m2', 'a', 'c')]);
    expect(moveProblem(subject, 'r1', { operandId: null, index: 0 })).toBe('This reply comes before the call it answers.');
    expect(moveProblem(subject, 'm2', { operandId: null, index: 0 })).toBeNull();
    expect(moveProblem(subject, 'm2', { operandId: null, index: 3 })).toBeNull();
  });

  it('a realistic order flow is clean', () => {
    const post = call('post', 'a', 'b');
    const save = call('save', 'b', 'c');
    const publish = createMessage({ id: 'publish', from: 'b', to: 'q', kind: 'async', label: 'OrderPlaced' });
    let subject = sequence([post, save, reply('saved', save), publish, reply('created', post)], ['a', 'b', 'c', 'q']);
    subject = wrapItems(subject, ['publish'], { id: 'par', operator: 'par' });
    subject = addOperand(subject, 'par', { id: 'audit' });
    subject = insertItem(subject, createMessage({ id: 'log', from: 'b', to: 'c', kind: 'async' }), { operandId: 'audit', index: 0 });
    expect(checkSequence(subject)).toEqual([]);
  });
});
