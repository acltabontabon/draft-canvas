import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { flowIsPlayable, nodeTierInPlayback } from '../src/document/flow';
import { addNodes } from '../src/document/operations';
import { isSequenceFlowOf, playbackFlowOf, sequenceFlow, sequenceFlowId, sequenceOfFlowId } from '../src/document/sequenceFlow';
import { addOperand, createMessage, createReply, insertItem, moveItem, wrapItems } from '../src/document/sequenceOps';
import type { DraftDocument, DraftNode, DraftSequence, SeqMessage, SeqParticipant } from '../src/document/types';
import { describeContext, describeSequenceFrame, describeSequenceMessages, naturalSequenceSizeFor } from '../src/nodes/describe';
import { sequenceStepBounds, stepComposition } from '../src/presentation/composition';
import { describeFlowStep } from '../src/presentation/flowChrome';
import { stepContextOf } from '../src/presentation/stepContext';
import { resolveFlowSteps } from '../src/presentation/useFlowPlayback';
import { LIGHT } from '../src/render/theme/tokens';
import type { Shape } from '../src/render/displayList';

const who = (id: string, name: string): SeqParticipant => ({ id, name, type: 'service', serviceKind: 'generic' });
const call = (id: string, from: string, to: string, label: string): SeqMessage => createMessage({ id, from, to, label });

function checkout(): DraftSequence {
  const post = call('post', 'store', 'api', 'POST /orders');
  const pay = call('pay', 'api', 'bank', 'authorize');
  let sequence: DraftSequence = {
    participants: [who('store', 'Storefront'), who('api', 'Checkout API'), who('bank', 'Payment Provider'), who('db', 'Orders')],
    items: [post, pay, { ...createReply(pay, 'approved'), id: 'approved' }, call('save', 'api', 'db', 'INSERT order'), createMessage({ id: 'audit', from: 'api', to: 'db', kind: 'async', label: '' }), { ...createReply(post, '201'), id: 'created' }],
  };
  sequence = wrapItems(sequence, ['pay', 'approved'], { id: 'alt', operator: 'alt', guard: 'card accepted' });
  sequence = addOperand(sequence, 'alt', { id: 'else' });
  sequence = insertItem(sequence, createMessage({ id: 'refuse', from: 'api', to: 'store', kind: 'reply', label: '402' }), { operandId: 'else', index: 0 });
  sequence = wrapItems(sequence, ['save'], { id: 'par', operator: 'par' });
  sequence = addOperand(sequence, 'par', { id: 'second' });
  return moveItem(sequence, 'audit', { operandId: 'second', index: 0 });
}

function docWith(sequence: DraftSequence): { doc: DraftDocument; node: DraftNode } {
  const bare = { ...createNode({ id: 'n_seq', type: 'sequence', x: 400, y: 100, text: 'Checkout' }), sequence };
  const node = { ...bare, ...naturalSequenceSizeFor(bare, describeContext(LIGHT)) };
  return { doc: addNodes(createDocument(), [node, createNode({ id: 'n_other', type: 'service', x: 0, y: 0 })]), node };
}

describe('a sequence told as a flow', () => {
  it('has one step per message, in the order they are drawn, each saying where it sits', () => {
    const { node } = docWith(checkout());
    const flow = sequenceFlow(node);
    expect(flow).toMatchObject({ id: 'seq:n_seq', title: 'Checkout' });
    expect(flow.steps.map((step) => [step.id, step.caption])).toEqual([
      ['post', 'POST /orders'],
      ['pay', '[card accepted] — authorize'],
      ['approved', '[card accepted] — approved'],
      ['refuse', '[else] — 402'],
      ['save', 'in parallel, branch 1 of 2 — INSERT order'],
      ['audit', 'in parallel, branch 2 of 2 — Message'],
      ['created', '201'],
    ]);
    expect(flow.steps.every((step) => step.extraNodeIds?.[0] === 'n_seq' && !step.edgeId)).toBe(true);
    expect(sequenceFlow(node)).toBe(flow);
  });

  it('is found by its id and is never one of the document’s own flows', () => {
    const { doc, node } = docWith(checkout());
    expect(playbackFlowOf(doc, sequenceFlowId('n_seq'))).toBe(sequenceFlow(node));
    expect(doc.flows).toEqual([]);
    expect(playbackFlowOf(doc, sequenceFlowId('n_other'))).toBeUndefined();
    expect(playbackFlowOf(doc, 'seq:nobody')).toBeUndefined();
    expect(playbackFlowOf(doc, null)).toBeUndefined();
    expect(flowIsPlayable(doc, sequenceFlow(node))).toBe(true);
    expect(flowIsPlayable(doc, sequenceFlow({ ...node, sequence: { participants: [], items: [] } }))).toBe(false);
  });

  it('knows whose telling a flow id is without building a string', () => {
    expect(sequenceOfFlowId('seq:n_seq')).toBe('n_seq');
    expect(sequenceOfFlowId('f_abc')).toBeNull();
    expect(isSequenceFlowOf('seq:n_seq', 'n_seq')).toBe(true);
    expect(isSequenceFlowOf('seq:n_seq2', 'n_seq')).toBe(false);
    expect(isSequenceFlowOf('f_n_seq', 'n_seq')).toBe(false);
    expect(isSequenceFlowOf(null, 'n_seq')).toBe(false);
  });
});

describe('stepping through it', () => {
  const { doc, node } = docWith(checkout());
  const steps = resolveFlowSteps(sequenceFlow(node), doc.edges, doc.nodes);
  const nodesById = new Map(doc.nodes.map((entry) => [entry.id, entry]));

  it('each step is about one message of that sequence', () => {
    expect(steps).toHaveLength(7);
    expect(steps.map((step) => step.part?.message.id)).toEqual(['post', 'pay', 'approved', 'refuse', 'save', 'audit', 'created']);
    expect(steps.every((step) => step.part?.nodeId === 'n_seq' && step.edges.length === 0)).toBe(true);
  });

  it('is told in the participants’ names', () => {
    expect(describeFlowStep(steps[1]!, nodesById)).toEqual({ headline: 'Checkout API to Payment Provider', from: 'Checkout API', to: 'Payment Provider', caption: '[card accepted] — authorize' });
  });

  it('frames the message and the two heads it runs between, not the whole sequence', () => {
    const bounds = stepComposition(steps[1]!, nodesById)!.bounds;
    expect(bounds).toEqual(sequenceStepBounds(node, steps[1]!.part!.message));
    expect(bounds.x).toBeGreaterThan(node.x);
    expect(bounds.x + bounds.width).toBeLessThan(node.x + node.width);
    expect(bounds.height).toBeLessThan(node.height);
    // Wider for a message that crosses more of the sequence.
    expect(stepComposition(steps[4]!, nodesById)!.bounds.width).toBeGreaterThan(bounds.width);
  });

  it('lights the sequence and dims everything else on the canvas', () => {
    const flow = sequenceFlow(node);
    const moment = { active: true, flowId: flow.id, step: 3 };
    expect(nodeTierInPlayback(flow, doc.edges, 'n_seq', moment)).toBe('active');
    expect(nodeTierInPlayback(flow, doc.edges, 'n_other', moment)).toBe('hidden');
    expect(stepContextOf({ document: doc, flowPlayback: moment })?.transitionKey).toBe('seq:n_seq:3:request');
  });

  it('draws only what the step is about, from the sequence’s own shapes', () => {
    const ctx = describeContext(LIGHT);
    const words = (shapes: readonly Shape[]): string[] =>
      shapes.flatMap((shape) => (shape.t === 'group' ? words(shape.children) : shape.t === 'text' ? [shape.layout.lines.map((line) => line.text).join(' ')] : []));
    const now = describeSequenceMessages(node, ctx, new Set(['pay']));
    expect(words(now).sort()).toEqual(['2', 'Checkout API', 'Payment Provider', 'authorize']);
    const all = describeSequenceMessages(node, ctx, new Set(['post', 'pay', 'approved']));
    expect(words(all)).toEqual(expect.arrayContaining(['POST /orders', 'authorize', 'approved', 'Storefront']));
    expect(words(all)).not.toContain('Orders');
    // And it is lit along its frame alone: two shapes, however much it holds.
    expect(describeSequenceFrame(node, ctx)).toHaveLength(2);
  });
});
