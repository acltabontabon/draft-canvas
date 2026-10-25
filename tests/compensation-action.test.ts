import { beforeEach, describe, expect, it } from 'vitest';
import { edgeCommands } from '../src/commands/registry';
import type { CommandContext } from '../src/commands/types';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { collapsedCompensationCount, linkedCompensations, normalizeCompensationHttpLabel, repairCompensationLinks, visibleEdges } from '../src/document/compensation';
import { addEdges, addNodes, extractFragment, pasteFragment, removeElements } from '../src/document/operations';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { repairReferences } from '../src/collab/repair';
import { dashForEdge } from '../src/edges/kindStyle';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/** A compensating business action remains a real, linked edge. */
describe('addCompensation()', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Saga'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  function step(target: { type: 'service' | 'database'; serviceKind?: 'external' } = { type: 'service' }) {
    const coordinator = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const participant = store.getState().addNode({ ...target, x: 400, y: 0 });
    store.getState().connect(coordinator.id, participant.id);
    const edge = store.getState().document.edges.at(-1)!;
    return { coordinator, participant, edge };
  }

  it('a second drag between two services draws the step\'s undo, a third is refused', () => {
    const { coordinator, participant, edge } = step();
    const twin = store.getState().connect(coordinator.id, participant.id)!;
    expect(twin).toMatchObject({ semantic: 'compensates', semanticsOrigin: 'explicit', compensationFor: edge.id, compensationVisible: true });
    expect(dashForEdge(twin)).toEqual([5, 4]);
    expect(store.getState().connect(coordinator.id, participant.id)).toBeNull();
    expect(store.getState().document.edges.map((e) => e.id)).toEqual([edge.id, twin.id]);
  });

  it('drawn the other way round — the undo first — the second drag is the step itself', () => {
    const { coordinator, participant, edge } = step();
    store.getState().updateEdgeById(edge.id, { semantic: 'compensates', semanticsOrigin: 'explicit' });
    const forward = store.getState().connect(coordinator.id, participant.id)!;
    expect(forward.semantic).toBe('calls');
    expect(forward.semanticsOrigin).toBe('inferred');
  });

  it('never allows a second arrow where the pairing has no compensation', () => {
    const { coordinator } = step();
    const db = store.getState().addNode({ type: 'database', x: 0, y: 400 });
    expect(store.getState().connect(coordinator.id, db.id)).not.toBeNull();
    expect(store.getState().connect(coordinator.id, db.id)).toBeNull();
  });

  it('adds a visible linked action in one undo step while keeping the step selected', () => {
    const { coordinator, participant, edge } = step();
    const before = store.getState().history.past.length;
    const id = store.getState().addCompensation(edge.id);
    const edges = store.getState().document.edges;
    expect(store.getState().history.past).toHaveLength(before + 1);
    expect(edges).toHaveLength(2);
    const twin = edges.find((e) => e.id !== edge.id)!;
    expect(twin).toMatchObject({ id, source: coordinator.id, target: participant.id, semantic: 'compensates', semanticsOrigin: 'explicit', compensationFor: edge.id, compensationVisible: true, compensationProtocol: 'calls' });
    expect(store.getState().selection).toEqual({ nodes: [], edges: [edge.id] });
    expect(visibleEdges(edges).map((item) => item.id)).toEqual([edge.id, id]);
    expect(collapsedCompensationCount(edges, edge.id)).toBe(0);

    store.getState().undo();
    expect(store.getState().document.edges).toHaveLength(1);
  });

  it('supports several actions for one step and removes each independently', () => {
    const { edge } = step();
    const first = store.getState().addCompensation(edge.id)!;
    const second = store.getState().addCompensation(edge.id)!;
    expect(first).not.toBe(second);
    expect(linkedCompensations(store.getState().document.edges, edge.id).map((item) => item.id)).toEqual([first, second]);
    expect(store.getState().addCompensation(first)).toBeNull();
    expect(visibleEdges(store.getState().document.edges).map((item) => item.id)).toEqual([edge.id, first, second]);
    store.getState().removeCompensation(first);
    expect(linkedCompensations(store.getState().document.edges, edge.id).map((item) => item.id)).toEqual([second]);
    store.getState().undo();
    expect(linkedCompensations(store.getState().document.edges, edge.id)).toHaveLength(2);
  });

  it('can use different valid participants and preserves the business direction', () => {
    const { coordinator, participant, edge } = step();
    const other = store.getState().addNode({ type: 'service', x: 0, y: 400 });
    const id = store.getState().addCompensation(edge.id)!;
    store.getState().setCompensationParticipants(id, other.id, participant.id);
    expect(store.getState().document.edges.find((item) => item.id === id)).toMatchObject({ source: other.id, target: participant.id, compensationFor: edge.id });
    store.getState().setCompensationParticipants(id, participant.id, coordinator.id);
    expect(store.getState().document.edges.find((item) => item.id === id)).toMatchObject({ source: participant.id, target: coordinator.id });
  });

  it('lets the canvas destination gesture create a linked action to another shape', () => {
    const { coordinator, edge } = step();
    const payments = store.getState().addNode({ type: 'service', x: 650, y: 360 });
    const actionId = store.getState().addCompensation(edge.id, payments.id)!;
    expect(store.getState().document.edges.find((item) => item.id === actionId)).toMatchObject({
      source: coordinator.id,
      target: payments.id,
      compensationFor: edge.id,
      compensationVisible: true,
    });
    expect(store.getState().addCompensation(edge.id, coordinator.id)).toBeNull();
  });

  it('deleting the step removes linked actions, flows safely and undo restores them', () => {
    const { edge } = step();
    const first = store.getState().addCompensation(edge.id)!;
    const second = store.getState().addCompensation(edge.id)!;
    store.getState().setSelection({ nodes: [], edges: [edge.id] });
    store.getState().deleteSelection();
    expect(store.getState().document.edges).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().document.edges.map((item) => item.id)).toEqual([edge.id, first, second]);
  });

  it('clears links when semantics change but keeps a remote orphan visibly editable', () => {
    const { edge } = step();
    const id = store.getState().addCompensation(edge.id)!;
    store.getState().updateEdgeById(id, { semantic: 'http', compensationName: 'Release reservation' });
    const changed = store.getState().document.edges.find((item) => item.id === id)!;
    expect(changed.compensationFor).toBeUndefined();
    expect(changed.compensationName).toBeUndefined();
    const orphan = repairReferences({ ...store.getState().document, edges: store.getState().document.edges.map((item) => item.id === id ? { ...item, semantic: 'compensates' as const, compensationFor: edge.id, compensationVisible: false } : item).filter((item) => item.id !== edge.id) });
    expect(orphan.edges[0]!.compensationFor).toBeUndefined();
    expect(visibleEdges(orphan.edges)).toHaveLength(1);
  });

  it('works toward an External System, and nowhere the matrix does not offer it', () => {
    const external = step({ type: 'service', serviceKind: 'external' });
    store.getState().addCompensation(external.edge.id);
    expect(store.getState().document.edges.filter((e) => e.semantic === 'compensates')).toHaveLength(1);

    const store2 = step({ type: 'database' });
    store.getState().addCompensation(store2.edge.id);
    expect(store.getState().document.edges.filter((e) => e.semantic === 'compensates')).toHaveLength(1);
  });

  it('is a connector command where it applies, and not on the undo itself', () => {
    const { edge } = step();
    const ctx = { editor: store.getState() } as unknown as CommandContext;
    expect(edgeCommands(ctx, edge).map((c) => c.id)).toContain('edge-add-compensation');
    store.getState().addCompensation(edge.id);
    const twin = store.getState().document.edges.at(-1)!;
    const ctx2 = { editor: store.getState() } as unknown as CommandContext;
    expect(edgeCommands(ctx2, twin).map((c) => c.id)).not.toContain('edge-add-compensation');
  });
});

describe('linked compensation files and fragments', () => {
  const a = createNode({ type: 'service', x: 0, y: 0 });
  const b = createNode({ type: 'service', x: 400, y: 0 });
  const step = createEdge({ source: a.id, target: b.id, semantic: 'http', label: 'POST /reservations' });
  const compensation = createEdge({ source: a.id, target: b.id, semantic: 'compensates', compensationFor: step.id, compensationVisible: false, compensationName: 'Release inventory', compensationProtocol: 'http', compensationDescription: 'After payment fails', label: 'POST /reservations/{id}/release' });
  const doc = addEdges(addNodes(createDocument('Order saga'), [a, b]), [step, compensation]);

  it('keeps array identities stable when links already belong to their room', () => {
    expect(repairCompensationLinks(doc.edges)).toBe(doc.edges);
    expect(visibleEdges(doc.edges)).toBe(visibleEdges(doc.edges));
    expect(linkedCompensations(doc.edges, step.id)).toBe(linkedCompensations(doc.edges, step.id));
    expect(visibleEdges([step])).toEqual([step]);
  });

  it('repairs generic operation text when a recovery action becomes HTTP', () => {
    expect(normalizeCompensationHttpLabel('OK')).toBeUndefined();
    expect(normalizeCompensationHttpLabel('Release reservation')).toBe('POST Release reservation');
    expect(normalizeCompensationHttpLabel('DELETE /reservations/1')).toBe('DELETE /reservations/1');
    const legacy = { ...compensation, label: 'OK' };
    expect(repairCompensationLinks([step, legacy])[1]?.label).toBeUndefined();
  });

  it('round-trips optional metadata without changing legacy independent edges', () => {
    const parsed = deserializeDocument(serializeDocument(doc));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.edges[1]).toMatchObject(compensation);
    const legacy = createEdge({ source: a.id, target: b.id, semantic: 'compensates' });
    expect(visibleEdges([...doc.edges, legacy])).toContain(legacy);
  });

  it('keeps old unlinked actions visible and repairs an invalid imported parent without losing the action', () => {
    const old = JSON.parse(serializeDocument(doc));
    old.version = 21;
    delete old.edges[1].compensationFor;
    delete old.edges[1].compensationVisible;
    const legacy = deserializeDocument(JSON.stringify(old));
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(visibleEdges(legacy.document.edges)).toHaveLength(2);

    const broken = JSON.parse(serializeDocument(doc));
    broken.edges[1].compensationFor = 'missing-step';
    const repaired = deserializeDocument(JSON.stringify(broken));
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.document.edges[1]!.compensationFor).toBeUndefined();
    expect(repaired.document.edges[1]!.compensationName).toBe('Release inventory');
    expect(visibleEdges(repaired.document.edges)).toHaveLength(2);
  });

  it('remaps copied parent and child ids, and exposes a child whose parent was truncated', () => {
    const fragment = extractFragment(doc, [a.id, b.id]);
    const pasted = pasteFragment(createDocument('Copy'), fragment, { x: 30, y: 30 });
    const copiedParent = pasted.doc.edges.find((item) => item.semantic === 'http')!;
    const copiedChild = pasted.doc.edges.find((item) => item.semantic === 'compensates')!;
    expect(copiedChild.compensationFor).toBe(copiedParent.id);
    expect(copiedChild.compensationFor).not.toBe(step.id);
    const orphan = removeElements(pasted.doc, [], [copiedParent.id]);
    expect(orphan.edges).toHaveLength(0);
  });

  it('leaves an independently copied action visible when its parent was outside the fragment', () => {
    const c = createNode({ type: 'service', x: 0, y: 300 });
    const d = createNode({ type: 'service', x: 400, y: 300 });
    const elsewhere = createEdge({ source: c.id, target: d.id, semantic: 'compensates', compensationFor: step.id, compensationVisible: false });
    const source = addEdges(addNodes(doc, [c, d]), [elsewhere]);
    const fragment = extractFragment(source, [c.id, d.id]);
    const pasted = pasteFragment(createDocument('Separate action'), fragment, { x: 0, y: 0 });
    expect(pasted.doc.edges).toHaveLength(1);
    expect(pasted.doc.edges[0]!.compensationFor).toBeUndefined();
    expect(visibleEdges(pasted.doc.edges)).toHaveLength(1);
  });

  it('remaps the link inside a duplicated room', () => {
    const owner = createNode({ type: 'service', x: 0, y: 0 });
    owner.inside = { nodes: [a, b], edges: [step, compensation], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const outer = addNodes(createDocument('Nested saga'), [owner]);
    const copied = pasteFragment(outer, extractFragment(outer, [owner.id]), { x: 30, y: 30 });
    const inside = copied.doc.nodes.at(-1)!.inside!;
    expect(inside.edges[1]!.compensationFor).toBe(inside.edges[0]!.id);
    expect(inside.edges[1]!.compensationFor).not.toBe(step.id);
  });
});
