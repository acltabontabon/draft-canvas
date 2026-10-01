import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes, countLabelMatches, replaceLabels } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { viewOf } from '../src/depth/tree';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/** A root with "Orders API" owning a room that holds "Orders worker" and a flow "Place order". */
function twoRooms(): DraftDocument {
  const worker = createNode({ type: 'service', x: 0, y: 0, text: 'Orders worker' });
  const owner = createNode({ type: 'service', x: 0, y: 0, text: 'Orders API' });
  owner.inside = {
    nodes: [{ ...worker, attachments: [{ id: 'att_1', type: 'note', text: 'Retries orders twice' }] }],
    edges: [],
    flows: [{ id: 'flow_inner', title: 'Place order', steps: [] }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const store = createNode({ type: 'database', x: 300, y: 0, text: 'Orders DB' });
  return addNodes(createDocument('Find'), [owner, store]);
}

describe('replaceLabels', () => {
  it('replaces in node text, attachment text, connector labels and flow titles, and counts every occurrence', () => {
    const doc = twoRooms();
    const room = viewOf(doc, [doc.nodes[0]!.id])!;
    const result = replaceLabels({ ...room, edges: [{ id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', label: 'sends order' }] }, 'order', 'invoice');
    expect(result.count).toBe(4);
    expect(result.doc.nodes[0]!.text).toBe('invoices worker');
    expect(result.doc.nodes[0]!.attachments![0]!.text).toBe('Retries invoices twice');
    expect(result.doc.edges[0]!.label).toBe('sends invoice');
    expect(result.doc.flows[0]!.title).toBe('Place invoice');
  });

  it('is case-insensitive unless asked, and whole-word only when asked', () => {
    const doc = twoRooms();
    expect(countLabelMatches(doc, 'orders')).toBe(2); // "Orders API", "Orders DB" at the root
    expect(countLabelMatches(doc, 'orders', { matchCase: true })).toBe(0);
    expect(countLabelMatches(doc, 'Orders', { matchCase: true })).toBe(2);
    expect(countLabelMatches(doc, 'order')).toBe(2); // inside "Orders"
    expect(countLabelMatches(doc, 'order', { wholeWord: true })).toBe(0);
    expect(countLabelMatches(doc, 'orders', { wholeWord: true })).toBe(2);
  });

  it('hands back the same document when nothing matches, and treats the needle literally', () => {
    const doc = twoRooms();
    const result = replaceLabels(doc, 'inventory', 'stock');
    expect(result.count).toBe(0);
    expect(result.doc).toBe(doc);
    expect(replaceLabels(doc, '.', 'x').count).toBe(0);
    expect(replaceLabels(doc, '', 'x').count).toBe(0);
    // `$&` in the replacement is text, not a back-reference.
    expect(replaceLabels(doc, 'DB', '$&!').doc.nodes[1]!.text).toBe('Orders $&!');
  });
});

describe('findAndReplace (store)', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: twoRooms(),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
      mode: 'edit',
      selectedFlowId: null,
      path: [],
      outer: null,
    });
  });

  it('reaches every room as one undo step, and stays in the room on screen', () => {
    const state = useEditorStore.getState();
    const ownerId = state.document.nodes[0]!.id;
    state.enterInside(ownerId);
    expect(useEditorStore.getState().path).toEqual([ownerId]);

    const count = useEditorStore.getState().findAndReplace('order', 'invoice');
    expect(count).toBe(5); // "Orders API" and "Orders DB" at the root; the worker's text, its note and the flow title inside

    const after = useEditorStore.getState();
    expect(after.path).toEqual([ownerId]);
    expect(after.document.nodes[0]!.text).toBe('invoices worker');
    expect(after.document.flows[0]!.title).toBe('Place invoice');
    expect(after.outer!.nodes.map((node) => node.text)).toEqual(['invoices API', 'invoices DB']);
    expect(after.history.past).toHaveLength(1);
    expect(after.history.past[0]!.label).toBe('Find and replace');

    after.undo();
    const restored = useEditorStore.getState();
    expect(restored.document.nodes[0]!.text).toBe('Orders worker');
    expect(restored.outer!.nodes[0]!.text).toBe('Orders API');
  });

  it('records nothing when nothing matches', () => {
    expect(useEditorStore.getState().findAndReplace('inventory', 'stock')).toBe(0);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
  });
});
