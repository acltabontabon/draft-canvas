import { sequenceLayoutFor } from '../src/nodes/describe';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { renderDocumentSvg } from '../src/render/svg/document';

import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { addParticipant, createMessage, insertItem, removeItems, updateSequence } from '../src/document/sequenceOps';
import type { DraftDocument, DraftNode, DraftSequence, SeqParticipant } from '../src/document/types';
import { describeContext, naturalSequenceSizeFor } from '../src/nodes/describe';
import { fitSequenceNode, fitSequences } from '../src/nodes/sequenceFit';
import { LIGHT } from '../src/render/theme/tokens';
import { minResizeSizeFor } from '../src/canvas/resizeSnap';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const ctx = () => describeContext(LIGHT);
const who = (id: string): SeqParticipant => ({ id, name: id, type: 'service', serviceKind: 'generic' });
const twoWay: DraftSequence = { participants: [who('client'), who('api')], items: [createMessage({ id: 'm1', from: 'client', to: 'api', label: 'GET /cart' })] };

const sequenceNode = (sequence: DraftSequence, box?: { width: number; height: number }): DraftNode => {
  const node = { ...createNode({ type: 'sequence', x: 100, y: 100, text: 'Cart' }), sequence };
  return box ? { ...node, ...box } : { ...node, ...naturalSequenceSizeFor(node, ctx()) };
};

const grow = (sequence: DraftSequence): DraftSequence =>
  insertItem(sequence, createMessage({ id: 'm2', from: 'api', to: 'client', kind: 'reply', label: 'the cart, with every line and its price' }), { operandId: null, index: 9 });

describe('a sequence’s size', () => {
  it('a snug box follows what it holds, both ways', () => {
    const before = sequenceNode(twoWay);
    const grown = fitSequenceNode(before, { ...before, sequence: grow(twoWay) }, ctx());
    expect(grown.height).toBeGreaterThan(before.height);
    expect({ width: grown.width, height: grown.height }).toEqual(naturalSequenceSizeFor(grown, ctx()));
    const shrunk = fitSequenceNode(grown, { ...grown, sequence: removeItems(grown.sequence!, ['m2']) }, ctx());
    expect({ width: shrunk.width, height: shrunk.height }).toEqual({ width: before.width, height: before.height });
  });

  it('a box made larger is left alone while everything fits, and grows only when it must', () => {
    const roomy = sequenceNode(twoWay, { width: 900, height: 700 });
    const same = fitSequenceNode(roomy, { ...roomy, sequence: grow(twoWay) }, ctx());
    expect([same.width, same.height]).toEqual([900, 700]);

    let crowded = roomy.sequence!;
    for (let index = 0; index < 12; index += 1) crowded = addParticipant(crowded, who(`p${index}`));
    const widened = fitSequenceNode(roomy, { ...roomy, sequence: crowded }, ctx());
    expect(widened.width).toBeGreaterThan(900);
    expect(widened.height).toBe(700);
  });

  it('a node that has just arrived is at least what it needs, and keeps a size larger than that', () => {
    const small = fitSequenceNode(undefined, sequenceNode(twoWay, { width: 60, height: 60 }), ctx());
    expect({ width: small.width, height: small.height }).toEqual(naturalSequenceSizeFor(small, ctx()));
    const large = sequenceNode(twoWay, { width: 1200, height: 900 });
    expect(fitSequenceNode(undefined, large, ctx())).toBe(large);
  });

  it('only sequences that changed are touched, and nothing else moves', () => {
    const sequence = sequenceNode(twoWay);
    const other = sequenceNode(twoWay);
    const shape = createNode({ type: 'service', x: 900, y: 0 });
    const before = addNodes(createDocument(), [sequence, other, shape]);
    const after = updateSequence(before, sequence.id, grow);
    const fitted = fitSequences(before, after, ctx);
    expect(fitted.nodes[0]!.height).toBeGreaterThan(sequence.height);
    expect([fitted.nodes[0]!.x, fitted.nodes[0]!.y]).toEqual([100, 100]);
    expect(fitted.nodes[1]).toBe(before.nodes[1]);
    expect(fitted.nodes[2]).toBe(before.nodes[2]);
    expect(fitSequences(before, before, ctx)).toBe(before);
  });

  it('cannot be resized below what it holds', () => {
    const node = sequenceNode(grow(twoWay));
    expect(minResizeSizeFor(node)).toEqual({ width: node.width, height: node.height });
    expect(minResizeSizeFor(createNode({ type: 'sequence', x: 0, y: 0 })).width).toBeGreaterThanOrEqual(200);
  });
});

describe('in the editor', () => {
  const state = () => useEditorStore.getState();
  const only = (): DraftNode => state().document.nodes.find((node) => node.type === 'sequence')!;
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Sequences'),
      path: [],
      outer: null,
      liveViewport: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      flowPlayback: { active: false, flowId: null, step: 0 },
      focus: { active: false, nodeIds: [], edgeIds: [] },
      selectedFlowId: null,
    });
  });

  it('every edit leaves the sequence the size it needs, as one undo step', () => {
    const created = state().addNode({ type: 'sequence', x: 0, y: 0 });
    const empty = { width: created.width, height: created.height };
    state().apply('Add participants', (doc: DraftDocument) =>
      updateSequence(doc, created.id, (sequence) => ['a', 'b', 'c', 'd', 'e'].reduce((next, id) => addParticipant(next, who(id)), sequence)),
    );
    expect(only().width).toBeGreaterThan(empty.width);
    expect(only().width).toBe(naturalSequenceSizeFor(only(), ctx()).width);
    state().undo();
    expect({ width: only().width, height: only().height }).toEqual(empty);
    expect(only().sequence!.participants).toHaveLength(0);
  });

  it('renaming it makes room for a long title', () => {
    const created = state().addNode({ type: 'sequence', x: 0, y: 0 });
    state().updateNodeText(created.id, 'What happens between the storefront, the checkout service and the bank when a shopper pays');
    expect(only().width).toBeGreaterThan(created.width);
  });

  it('a resize gives room and never takes away what is needed', () => {
    const created = state().addNode({ type: 'sequence', x: 0, y: 0 });
    state().apply('Fill', (doc: DraftDocument) => updateSequence(doc, created.id, () => grow(twoWay)));
    const needed = naturalSequenceSizeFor(only(), ctx());
    state().resizeNode(created.id, { width: 40, height: 40 });
    expect({ width: only().width, height: only().height }).toEqual(needed);
    state().resizeNode(created.id, { width: needed.width + 200, height: needed.height + 100 });
    expect({ width: only().width, height: only().height }).toEqual({ width: needed.width + 200, height: needed.height + 100 });
  });

  it('a copy keeps the size of the original', () => {
    const created = state().addNode({ type: 'sequence', x: 0, y: 0 });
    state().apply('Fill', (doc: DraftDocument) => updateSequence(doc, created.id, () => grow(twoWay)));
    state().resizeNode(created.id, { width: 800, height: 600 });
    state().setSelection({ nodes: [created.id], edges: [] });
    state().duplicateSelection();
    const copies = state().document.nodes.filter((node) => node.type === 'sequence');
    expect(copies).toHaveLength(2);
    expect([copies[1]!.width, copies[1]!.height]).toEqual([800, 600]);
    expect(copies[1]!.sequence).toEqual(copies[0]!.sequence);
  });
});

it('fits all 600 rows within the editable frame and the SVG viewport, including previously capped files', () => {
  const sequence = { ...twoWay, items: Array.from({ length: 600 }, (_, index) =>
    createMessage({ id: `m-${index}`, from: 'client', to: 'api', label: `Request ${index + 1}` }),
  ) };
  const capped = sequenceNode(sequence, { width: 350, height: 20_000 });
  const node = fitSequenceNode(undefined, capped, ctx());
  const row = sequenceLayoutFor(node, ctx()).messages.at(-1)!;
  expect(row.yEnd).toBeGreaterThan(20_000);
  expect(node.height).toBeGreaterThan(row.yEnd);
  const doc = addNodes(createDocument(), [node]);
  const saved = deserializeDocument(serializeDocument(doc));
  expect(saved.ok && saved.document.nodes[0]?.height).toBe(node.height);
  expect(renderDocumentSvg(doc).height).toBeGreaterThan(row.yEnd);
  expect(renderDocumentSvg({ ...doc, nodes: [capped] }).height).toBeGreaterThan(row.yEnd);
});
