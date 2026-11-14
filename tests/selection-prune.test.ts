import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, removeElements } from '../src/document/operations';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * An edit that removes selected shapes drops them from the selection — judged by the ids, never by
 * counting: one shape removed and another added leaves the totals where they were and a selected id
 * gone, and what was kept then was a selection of something that no longer exists.
 */

const store = useEditorStore;

beforeEach(() => {
  __resetInteraction();
  store.getState().setDocument(createDocument('Selection'));
  store.setState({ selection: { nodes: [], edges: [] }, history: { past: [], future: [] } });
});

function seed() {
  const [a, b, c] = ['a', 'b', 'c'].map((id, index) => createNode({ id, type: 'service', x: index * 300, y: 0, text: id }));
  const ab = createEdge({ id: 'ab', source: 'a', target: 'b' });
  const bc = createEdge({ id: 'bc', source: 'b', target: 'c' });
  store.getState().setDocument(addEdges(addNodes(createDocument('Selection'), [a!, b!, c!]), [ab, bc]));
}

describe('what an edit does to the selection', () => {
  it('drops a selected shape that was swapped for another, though the counts match', () => {
    seed();
    store.getState().setSelection({ nodes: ['a', 'b'], edges: [] });
    store.getState().apply('Swap', (doc) => addNodes(removeElements(doc, ['a']), [createNode({ id: 'd', type: 'service', x: 900, y: 0, text: 'd' })]));
    expect(store.getState().document.nodes).toHaveLength(3);
    expect(store.getState().selection).toEqual({ nodes: ['b'], edges: [] });
  });

  it('drops a selected connector that was swapped for another, though the counts match', () => {
    seed();
    store.getState().setSelection({ nodes: [], edges: ['ab'] });
    store.getState().apply('Swap', (doc) => {
      const without = { ...doc, edges: doc.edges.filter((edge) => edge.id !== 'ab') };
      return addEdges(without, [createEdge({ id: 'ac', source: 'a', target: 'c' })]);
    });
    expect(store.getState().document.edges).toHaveLength(2);
    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
  });

  it('drops a selected shape when an edit removes it, as before', () => {
    seed();
    store.getState().setSelection({ nodes: ['a', 'c'], edges: [] });
    store.getState().apply('Remove', (doc) => removeElements(doc, ['c']));
    expect(store.getState().selection).toEqual({ nodes: ['a'], edges: [] });
  });

  it('keeps the very same selection when everything selected survives', () => {
    seed();
    store.getState().setSelection({ nodes: ['a', 'b'], edges: ['ab'] });
    const before = store.getState().selection;
    store.getState().apply('Rename', (doc) => ({ ...doc, nodes: doc.nodes.map((node) => (node.id === 'c' ? { ...node, text: 'renamed' } : node)) }));
    expect(store.getState().selection).toBe(before);
    store.getState().apply('Add', (doc) => addNodes(doc, [createNode({ id: 'e', type: 'service', x: 0, y: 500, text: 'e' })]));
    expect(store.getState().selection).toBe(before);
  });

  it('keeps an empty selection as it is, whatever the edit', () => {
    seed();
    const before = store.getState().selection;
    store.getState().apply('Remove', (doc) => removeElements(doc, ['a']));
    expect(store.getState().selection).toBe(before);
  });
});
