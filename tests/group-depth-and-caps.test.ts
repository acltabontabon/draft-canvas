/**
 * Two limits a file keeps — nesting depth and node count — enforced where the edit is made, not only
 * where the file is next opened: a repair that undoes the person's work on reload is a bug found late.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { addNodes, fitsGroupDepth, setParent } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';
import { sequenceActions } from '../src/store/sequenceActions';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

const store = useEditorStore;

beforeEach(() => {
  __resetInteraction();
  store.setState({
    document: createDocument('Limits'),
    path: [],
    outer: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
  useUiStore.setState({ toasts: [] });
});

const lastToast = () => useUiStore.getState().toasts.at(-1)?.message;

describe('boundaries nest only as deep as a file keeps', () => {
  it('stops 40 Group commands at the limit, and the file reloads with nothing repaired', () => {
    const leaf = createNode({ type: 'service', x: 0, y: 0, text: 'Orders' });
    store.setState({ document: addNodes(createDocument('Deep'), [leaf]) });
    let refused = 0;
    for (let i = 0; i < 40; i += 1) {
      // The outermost shape is what Group wraps next.
      const roots = store.getState().document.nodes.filter((node) => node.parentId === undefined);
      store.getState().setSelection({ nodes: roots.map((node) => node.id), edges: [] });
      const before = store.getState().document;
      store.getState().groupSelection();
      if (store.getState().document === before) refused += 1;
    }
    const boundaries = store.getState().document.nodes.filter((node) => node.type === 'group');
    expect(boundaries).toHaveLength(LIMITS.maxGroupDepth);
    expect(refused).toBe(40 - LIMITS.maxGroupDepth);
    expect(lastToast()).toBe(`Nothing grouped — boundaries can be nested ${LIMITS.maxGroupDepth} levels deep at most.`);
    // The refusal leaves one undo step per boundary made, and none for the ones that were refused.
    expect(store.getState().history.past).toHaveLength(LIMITS.maxGroupDepth);

    const reloaded = parseDocument(serializeDocument(fileOf(store.getState())));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.repairs).toEqual([]);
    expect(reloaded.document.nodes.filter((node) => node.parentId !== undefined)).toHaveLength(LIMITS.maxGroupDepth);
  });

  it('refuses to move a boundary — with what is in it — under one that would make it too deep', () => {
    // A chain `maxGroupDepth - 1` boundaries deep, a separate boundary holding a boundary holding a shape.
    const chain = Array.from({ length: LIMITS.maxGroupDepth - 1 }, (_, i) => createNode({ id: `c${i}`, type: 'group', x: 0, y: 0 }));
    const linked = chain.map((node, i) => (i === 0 ? node : { ...node, parentId: chain[i - 1]!.id }));
    const inner = createNode({ id: 'inner', type: 'group', x: 900, y: 0 });
    const outer = createNode({ id: 'outer', type: 'group', x: 900, y: 0 });
    const shape = createNode({ id: 'leaf', type: 'service', x: 900, y: 0 });
    const doc = addNodes(createDocument('Chain'), [...linked, { ...inner, parentId: 'outer' }, outer, { ...shape, parentId: 'inner' }]);
    const tail = chain.at(-1)!.id;
    // `outer` brings two levels with it: it would end 31 + 1 + 2 = 34 deep.
    expect(fitsGroupDepth(doc, ['outer'], tail)).toBe(false);
    expect(setParent(doc, ['outer'], tail)).toBe(doc);
    // A shape alone fits: its own level is the last one allowed.
    expect(fitsGroupDepth(doc, ['leaf'], tail)).toBe(true);
    expect(setParent(doc, ['leaf'], tail).nodes.find((node) => node.id === 'leaf')?.parentId).toBe(tail);
    // Moving out is always fine.
    expect(fitsGroupDepth(doc, ['c5'], undefined)).toBe(true);
  });

  it('a child that would be too deep stays where it was while the others move', () => {
    const chain = Array.from({ length: LIMITS.maxGroupDepth }, (_, i) => createNode({ id: `c${i}`, type: 'group', x: 0, y: 0 }));
    const linked = chain.map((node, i) => (i === 0 ? node : { ...node, parentId: chain[i - 1]!.id }));
    const stray = createNode({ id: 'stray', type: 'group', x: 900, y: 0 });
    const inside = { ...createNode({ id: 'inside', type: 'service', x: 900, y: 0 }), parentId: 'stray' };
    const leaf = createNode({ id: 'leaf', type: 'service', x: 900, y: 0 });
    const doc = addNodes(createDocument('Mixed'), [...linked, stray, inside, leaf]);
    const moved = setParent(doc, ['stray', 'leaf'], chain.at(-1)!.id);
    const parentOf = (id: string) => moved.nodes.find((node) => node.id === id)?.parentId;
    // The tail sits 31 boundaries down. A shape under it is the 32nd step and fits; a boundary with
    // a shape in it would reach the 33rd, so it stays where it was.
    expect(parentOf('leaf')).toBe(chain.at(-1)!.id);
    expect(parentOf('stray')).toBeUndefined();
    expect(parentOf('inside')).toBe('stray');
  });
});

describe('a sequence made from shapes or a flow respects the node cap', () => {
  const full = () => {
    const filler = Array.from({ length: LIMITS.maxNodes }, (_, i) => createNode({ id: `f${i}`, type: 'service', x: i, y: 0 }));
    return addNodes(createDocument('Full'), filler);
  };

  it('createFromShapes adds nothing, and says why, when the file is full', () => {
    store.setState({ document: full() });
    expect(sequenceActions.createFromShapes(['f1', 'f2'])).toBeNull();
    expect(store.getState().document.nodes).toHaveLength(LIMITS.maxNodes);
    expect(store.getState().history.past).toHaveLength(0);
    expect(lastToast()).toBe('Nothing added — that would make this diagram too large.');
  });

  it('createFromFlow adds nothing when the file is full', () => {
    store.setState({ document: full() });
    store.getState().setSelection({ nodes: ['f1', 'f2'], edges: [] });
    expect(sequenceActions.createFromFlow('missing-flow')).toBeNull();
    expect(store.getState().document.nodes).toHaveLength(LIMITS.maxNodes);
  });

  it('still makes one with room to spare', () => {
    store.setState({ document: addNodes(createDocument('Roomy'), [createNode({ id: 'a', type: 'service', x: 0, y: 0 })]) });
    expect(sequenceActions.createFromShapes(['a'])).not.toBeNull();
    expect(store.getState().document.nodes).toHaveLength(2);
  });
});
