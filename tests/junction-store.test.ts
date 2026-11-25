import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { counterpartsOf, junctionOf, membersOf } from '../src/junctions/groups';
import { EMPTY_TRAIL, travel } from '../src/junctions/trail';
import { __resetInteraction, fileOf, useEditorStore } from '../src/store/editorStore';
import { junctionPeerCount } from '../src/store/junctions';
import { useUiStore } from '../src/store/uiStore';

const store = useEditorStore;

function open(nodes: DraftNode[] = []) {
  __resetInteraction();
  store.setState({
    document: { ...createDocument('Junctions'), nodes },
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
  useUiStore.setState({ readOnly: null, junctionPeek: null, junctionPlacing: null, junctionTrail: EMPTY_TRAIL, armed: null, pencil: null });
}

const file = (): DraftDocument => fileOf(store.getState());
const undoCount = () => store.getState().history.past.length;

describe('linked junctions in the editor', () => {
  beforeEach(() => open());

  it('adds a counterpart as one undo step: the same label, colour and size, in the same group, selected where it landed', () => {
    const source = store.getState().addNode({ type: 'ellipse', x: 100, y: 100, accent: 'violet', width: 48, height: 48 });
    const steps = undoCount();
    const made = store.getState().addJunctionCounterpart(source.id, { x: 2000, y: 900 })!;
    expect(undoCount()).toBe(steps + 1);
    expect(store.getState().history.past[steps]!.label).toBe('Add linked junction');
    const linked = junctionOf(file(), source.id)!.node;
    expect(linked.link).toMatch(/^j_/);
    expect(linked.text).toBe('A');
    expect(made).toMatchObject({ type: 'ellipse', link: linked.link, text: 'A', accent: 'violet', width: 48, height: 48 });
    // Centred on the click.
    expect(made.x + made.width / 2).toBe(2000);
    expect(made.y + made.height / 2).toBe(900);
    expect(store.getState().selection).toEqual({ nodes: [made.id], edges: [] });
    expect(counterpartsOf(file(), source.id).map((member) => member.node.id)).toEqual([made.id]);

    // One undo takes the counterpart and the link away together; redo brings both back.
    store.getState().undo();
    expect(store.getState().document.nodes.map((node) => node.id)).toEqual([source.id]);
    expect('link' in store.getState().document.nodes[0]!).toBe(false);
    expect(store.getState().document.nodes[0]!.text ?? '').toBe('');
    store.getState().redo();
    expect(membersOf(file(), linked.link)).toHaveLength(2);
  });

  it('names each new group with the next free letter, and adds a third place to a group that has two', () => {
    const first = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    store.getState().addJunctionCounterpart(first.id, { x: 900, y: 0 });
    const second = store.getState().addNode({ type: 'ellipse', x: 0, y: 300 });
    const b = store.getState().addJunctionCounterpart(second.id, { x: 900, y: 300 })!;
    expect(b.text).toBe('B');
    const third = store.getState().addJunctionCounterpart(first.id, { x: 900, y: 600 })!;
    expect(third.text).toBe('A');
    expect(membersOf(file(), third.link)).toHaveLength(3);
    expect(membersOf(file(), b.link)).toHaveLength(2);
  });

  it('refuses a counterpart of something gone, and makes none on a shared read-only diagram', () => {
    expect(store.getState().addJunctionCounterpart('missing', { x: 0, y: 0 })).toBeNull();
    const source = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    useUiStore.setState({ readOnly: { sharedTitle: 'Shared' } });
    expect(store.getState().addJunctionCounterpart(source.id, { x: 500, y: 0 })).toBeNull();
    expect(store.getState().document.nodes).toHaveLength(1);
  });

  it('typing a new label on one member renames the group everywhere, as one undo step', () => {
    const a = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    const b = store.getState().addJunctionCounterpart(a.id, { x: 900, y: 0 })!;
    const steps = undoCount();
    store.getState().updateNodeText(b.id, 'Settle');
    expect(undoCount()).toBe(steps + 1);
    expect(membersOf(file(), b.link).map((member) => member.node.text)).toEqual(['Settle', 'Settle']);
    store.getState().undo();
    expect(membersOf(file(), b.link).map((member) => member.node.text)).toEqual(['A', 'A']);
    // A standalone junction's text is its own.
    const plain = store.getState().addNode({ type: 'ellipse', x: 0, y: 600 });
    store.getState().updateNodeText(plain.id, 'X');
    expect(membersOf(file(), b.link).map((member) => member.node.text)).toEqual(['A', 'A']);
  });

  it('links existing junctions, joins one to a group, and unlinks it again, each undoable', () => {
    const a = store.getState().addNode({ type: 'ellipse', x: 0, y: 0, text: 'A' });
    const b = store.getState().addNode({ type: 'ellipse', x: 900, y: 0, text: 'A' });
    const c = store.getState().addNode({ type: 'ellipse', x: 0, y: 900 });
    const link = store.getState().linkJunctions([a.id, b.id])!;
    expect(link).toMatch(/^j_/);
    expect(store.getState().linkJunctions([a.id, b.id])).toBeNull(); // already so: no empty undo step
    expect(store.getState().linkJunctions([c.id], link)).toBe(link);
    expect(membersOf(file(), link).map((member) => member.node.text)).toEqual(['A', 'A', 'A']);
    expect(store.getState().unlinkJunctions([b.id])).toBe(true);
    expect(store.getState().unlinkJunctions([b.id])).toBe(false);
    expect(membersOf(file(), link).map((member) => member.node.id)).toEqual([a.id, c.id]);
    expect(junctionOf(file(), b.id)!.node.text).toBe('A');
    store.getState().undo();
    expect(membersOf(file(), link)).toHaveLength(3);
  });

  it('deleting a counterpart leaves the other waiting, and undo makes them a pair again', () => {
    const a = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    const b = store.getState().addJunctionCounterpart(a.id, { x: 900, y: 0 })!;
    store.getState().setSelection({ nodes: [b.id], edges: [] });
    store.getState().deleteSelection();
    const left = junctionOf(file(), a.id)!.node;
    expect(left.link).toBe(b.link);
    expect(junctionPeerCount(store.getState(), left.link)).toBe(0);
    store.getState().undo();
    expect(junctionPeerCount(store.getState(), left.link)).toBe(1);
  });

  it('duplicating one linked junction adds a place; duplicating the pair makes a pair of its own', () => {
    const a = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    const b = store.getState().addJunctionCounterpart(a.id, { x: 900, y: 0 })!;
    store.getState().setSelection({ nodes: [a.id], edges: [] });
    store.getState().duplicateSelection();
    expect(membersOf(file(), b.link)).toHaveLength(3);
    store.getState().undo();

    store.getState().setSelection({ nodes: [a.id, b.id], edges: [] });
    store.getState().duplicateSelection();
    const copies = store.getState().selection.nodes.map((id) => junctionOf(file(), id)!.node);
    expect(copies).toHaveLength(2);
    expect(copies[0]!.link).toBe(copies[1]!.link);
    expect(copies[0]!.link).not.toBe(b.link);
    expect(membersOf(file(), b.link)).toHaveLength(2);

    // Copy and paste follow the same rule.
    store.getState().setSelection({ nodes: [a.id, b.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 3000, y: 3000 });
    const pasted = store.getState().selection.nodes.map((id) => junctionOf(file(), id)!.node);
    expect(new Set(pasted.map((node) => node.link)).size).toBe(1);
    expect(pasted[0]!.link).not.toBe(b.link);
    expect(pasted[0]!.link).not.toBe(copies[0]!.link);
  });
});

describe('linked junctions across rooms', () => {
  it('counts the places elsewhere from inside a room, and renames them from there', () => {
    const orders = createNode({ id: 'orders', type: 'service', x: 0, y: 400, text: 'Orders' });
    const top = { ...createNode({ id: 'top', type: 'ellipse', x: 0, y: 0, text: 'A' }), link: 'g' };
    open([top, orders]);
    expect(junctionPeerCount(store.getState(), 'g')).toBe(0);
    expect(store.getState().enterInside('orders')).toBe(true);
    const deep = store.getState().addJunctionCounterpart('top', { x: 50, y: 50 })!;
    expect(store.getState().path).toEqual(['orders']);
    expect(deep.link).toBe('g');
    expect(store.getState().document.nodes.map((node) => node.id)).toEqual([deep.id]);
    expect(membersOf(file(), 'g').map((member) => member.path)).toEqual([[], ['orders']]);
    // From inside the room, the one at the top level is the other place.
    expect(junctionPeerCount(store.getState(), 'g')).toBe(1);
    const second = store.getState().addJunctionCounterpart(deep.id, { x: 300, y: 50 })!;
    expect(junctionPeerCount(store.getState(), 'g')).toBe(2);

    store.getState().updateNodeText(second.id, 'Hand-off');
    expect(membersOf(file(), 'g').map((member) => member.node.text)).toEqual(['Hand-off', 'Hand-off', 'Hand-off']);
    store.getState().exitTo(0);
    expect(store.getState().document.nodes.find((node) => node.id === 'top')!.text).toBe('Hand-off');
    expect(junctionPeerCount(store.getState(), 'g')).toBe(2);
    expect(junctionPeerCount(store.getState(), 'nothing')).toBe(0);
    expect(junctionPeerCount(store.getState(), undefined)).toBe(0);
  });
});

describe('what is not an edit', () => {
  beforeEach(() => open());

  it('a trail, a peek and a counterpart in hand leave the document, its history and its revision alone', () => {
    const a = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    store.getState().addJunctionCounterpart(a.id, { x: 900, y: 0 });
    const before = store.getState();
    const ui = useUiStore.getState();
    ui.setJunctionPeek({ id: a.id, by: 'hover' });
    ui.setJunctionPlacing({ sourceId: a.id });
    ui.setJunctionTrail(travel(EMPTY_TRAIL, before.document.metadata.id, { path: [], camera: { x: 0, y: 0, zoom: 1 }, label: 'A' }, { path: [], camera: { x: -900, y: 0, zoom: 1 }, label: 'A' }));
    ui.setJunctionPeerLink('whatever');
    const after = store.getState();
    expect(after.document).toBe(before.document);
    expect(after.history).toBe(before.history);
    expect(after.revision).toBe(before.revision);
    // And undo knows nothing of where the camera has been.
    store.getState().undo();
    expect(useUiStore.getState().junctionTrail.stops).toHaveLength(2);
  });

  it('holds one tool at a time: a counterpart in hand puts down the shape tool, and picking one up puts it down', () => {
    const ui = useUiStore.getState();
    ui.arm({ id: 'service', label: 'Service', type: 'service', shortcut: 'S', hint: '' } as never);
    ui.setJunctionPlacing({ sourceId: 'x' });
    expect(useUiStore.getState().armed).toBeNull();
    expect(useUiStore.getState().junctionPlacing).toEqual({ sourceId: 'x' });
    useUiStore.getState().setPencil('pen');
    expect(useUiStore.getState().junctionPlacing).toBeNull();
    useUiStore.getState().setPencil(null);
    useUiStore.getState().setJunctionPlacing({ sourceId: 'x' });
    useUiStore.getState().arm({ id: 'service', label: 'Service', type: 'service', shortcut: 'S', hint: '' } as never);
    expect(useUiStore.getState().junctionPlacing).toBeNull();
  });

  it('keeps a counterpart in hand across a move to another room, and lets go of what was anchored there', () => {
    const orders = createNode({ id: 'orders', type: 'service', x: 0, y: 400, text: 'Orders' });
    const top = { ...createNode({ id: 'top', type: 'ellipse', x: 0, y: 0, text: 'A' }), link: 'g' };
    open([top, orders]);
    useUiStore.getState().setJunctionPeek({ id: 'top', by: 'ask' });
    useUiStore.getState().setJunctionPlacing({ sourceId: 'top' });
    store.getState().enterInside('orders');
    expect(useUiStore.getState().junctionPlacing).toEqual({ sourceId: 'top' });
    expect(useUiStore.getState().junctionPeek).toBeNull();
  });

  it('takes a collaborator’s edit of a link without an undo step of its own', () => {
    const a = store.getState().addNode({ type: 'ellipse', x: 0, y: 0 });
    const b = store.getState().addJunctionCounterpart(a.id, { x: 900, y: 0 })!;
    const steps = undoCount();
    const current = file();
    // Somebody else renames the group and adds a third place.
    const remote: DraftDocument = {
      ...current,
      nodes: [...current.nodes.map((node) => (node.link ? { ...node, text: 'Pay' } : node)), { ...createNode({ id: 'theirs', type: 'ellipse', x: 0, y: 900, text: 'Pay' }), link: b.link! }],
    };
    expect(store.getState().applyRemote(remote)).toBe(true);
    expect(undoCount()).toBe(steps);
    expect(membersOf(file(), b.link).map((member) => member.node.text)).toEqual(['Pay', 'Pay', 'Pay']);
    expect(junctionPeerCount(store.getState(), b.link)).toBe(2);
  });
});
