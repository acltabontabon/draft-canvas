import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge } from '../src/document/factory';
import {
  addFlow,
  addStepToFlow,
  createFlow,
  deleteFlow,
  explainEdgeTier,
  explainNodeTier,
  moveStepInFlow,
  pruneFlowSteps,
  removeStepFromFlow,
  renameFlow,
  stepIndexOf,
  updateFlowStepCaption,
} from '../src/document/flow';
import { removeElements } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function chain(length: number) {
  __resetInteraction();
  store.setState({
    document: createDocument('Flows'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    flowPlayback: { active: false, flowId: null, step: 0 },
    selectedFlowId: null,
  });

  const nodes = Array.from({ length: length + 1 }, (_, index) =>
    store.getState().addNode({ type: 'service', x: index * 240, y: 0, text: `N${index}` }),
  );
  const edges = nodes.slice(0, -1).map((node, index) =>
    store.getState().connect(node.id, nodes[index + 1]!.id)!,
  );
  return { nodes, edges };
}

describe('flow.ts pure functions', () => {
  it('finds an edge position within a flow, 1-based', () => {
    const flow = createFlow({ title: 'X' });
    flow.steps = [
      { id: 's1', edgeId: 'e1' },
      { id: 's2', edgeId: 'e2' },
    ];
    expect(stepIndexOf(flow, 'e1')).toBe(1);
    expect(stepIndexOf(flow, 'e2')).toBe(2);
    expect(stepIndexOf(flow, 'missing')).toBeUndefined();
    expect(stepIndexOf(undefined, 'e1')).toBeUndefined();
  });

  it('classifies an edge as active, shown, or hidden relative to the current step', () => {
    expect(explainEdgeTier(3, 3)).toBe('active');
    expect(explainEdgeTier(1, 3)).toBe('shown');
    expect(explainEdgeTier(5, 3)).toBe('hidden');
    expect(explainEdgeTier(undefined, 3)).toBe('hidden');
  });

  it('gives a node the most-lit tier among the flow edges touching it', () => {
    const a = createEdge({ source: 'x', target: 'shared' });
    const b = createEdge({ source: 'shared', target: 'y' });
    const flow = createFlow({ title: 'X' });
    // Pad two intervening steps so b lands on step 4 relative to a's step 1,
    // mirroring "step 1 shown, step 4 active" at the current step 3.
    flow.steps = [
      { id: 's1', edgeId: a.id },
      { id: 'p1', edgeId: 'pad1' },
      { id: 'p2', edgeId: 'pad2' },
      { id: 's2', edgeId: b.id },
    ];
    const edges = [a, b];

    expect(explainNodeTier(flow, edges, 'shared', 3)).toBe('shown');
    expect(explainNodeTier(flow, edges, 'x', 3)).toBe('shown');
    expect(explainNodeTier(flow, edges, 'y', 3)).toBe('hidden');
    expect(explainNodeTier(flow, edges, 'shared', 4)).toBe('active');
    expect(explainNodeTier(flow, edges, 'unrelated', 3)).toBe('hidden');
    expect(explainNodeTier(undefined, edges, 'shared', 3)).toBe('hidden');
  });

  it('creates a flow with a default or given title, and appends it', () => {
    const doc = createDocument('X');
    const flow = createFlow({ title: 'Happy path' });
    const next = addFlow(doc, flow);
    expect(next.flows).toHaveLength(1);
    expect(next.flows[0]!.title).toBe('Happy path');
    expect(next.flows[0]!.steps).toEqual([]);
  });

  it('renames a flow, and is a no-op for an unknown id or unchanged title', () => {
    const doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    const renamed = renameFlow(doc, 'f1', 'B');
    expect(renamed.flows[0]!.title).toBe('B');
    expect(renameFlow(doc, 'missing', 'C')).toBe(doc);
    expect(renameFlow(doc, 'f1', 'A')).toBe(doc);
  });

  it('deletes a flow, and is a no-op for an unknown id', () => {
    const doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    expect(deleteFlow(doc, 'f1').flows).toHaveLength(0);
    expect(deleteFlow(doc, 'missing')).toBe(doc);
  });

  it('adds a step to a flow, refusing a duplicate edge or an edge that does not exist', () => {
    const edge = createEdge({ source: 'a', target: 'b', id: 'e1' });
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, edges: [edge] };

    doc = addStepToFlow(doc, 'f1', 'e1');
    expect(doc.flows[0]!.steps.map((s) => s.edgeId)).toEqual(['e1']);

    // Already a step — no-op.
    expect(addStepToFlow(doc, 'f1', 'e1')).toBe(doc);
    // Edge does not exist on the document — no-op.
    expect(addStepToFlow(doc, 'f1', 'nonexistent')).toBe(doc);
  });

  it('removes and reorders steps', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, edges: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] as never };
    doc = addStepToFlow(doc, 'f1', 'e1');
    doc = addStepToFlow(doc, 'f1', 'e2');
    doc = addStepToFlow(doc, 'f1', 'e3');
    const [s1, s2] = doc.flows[0]!.steps;

    const moved = moveStepInFlow(doc, 'f1', s2!.id, -1);
    expect(moved.flows[0]!.steps.map((s) => s.edgeId)).toEqual(['e2', 'e1', 'e3']);
    // Cannot move the first step earlier.
    expect(moveStepInFlow(doc, 'f1', s1!.id, -1)).toBe(doc);

    const removed = removeStepFromFlow(doc, 'f1', s1!.id);
    expect(removed.flows[0]!.steps.map((s) => s.edgeId)).toEqual(['e2', 'e3']);
  });

  it('sets and clears a step caption', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, edges: [{ id: 'e1' }] as never };
    doc = addStepToFlow(doc, 'f1', 'e1');
    const stepId = doc.flows[0]!.steps[0]!.id;

    doc = updateFlowStepCaption(doc, 'f1', stepId, 'Create the order');
    expect(doc.flows[0]!.steps[0]!.caption).toBe('Create the order');

    doc = updateFlowStepCaption(doc, 'f1', stepId, '');
    expect(doc.flows[0]!.steps[0]!.caption).toBeUndefined();
  });

  it('prunes steps referencing removed edges across every flow', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = addFlow(doc, createFlow({ title: 'B', id: 'f2' }));
    doc = { ...doc, edges: [{ id: 'e1' }, { id: 'e2' }] as never };
    doc = addStepToFlow(doc, 'f1', 'e1');
    doc = addStepToFlow(doc, 'f1', 'e2');
    doc = addStepToFlow(doc, 'f2', 'e1');

    const pruned = pruneFlowSteps(doc, new Set(['e1']));
    expect(pruned.flows[0]!.steps.map((s) => s.edgeId)).toEqual(['e2']);
    expect(pruned.flows[1]!.steps).toEqual([]);
    // Nothing referenced the removed set — same reference back.
    expect(pruneFlowSteps(doc, new Set(['nonexistent']))).toBe(doc);
  });
});

describe('flows through the store', () => {
  beforeEach(() => chain(0));

  it('creates a flow and adds connectors to it in order', () => {
    const { edges } = chain(3);
    const flowId = store.getState().createFlow('Happy path');
    for (const edge of edges) store.getState().addEdgeToFlow(flowId, edge.id);

    const flow = store.getState().document.flows.find((f) => f.id === flowId)!;
    expect(flow.steps.map((s) => s.edgeId)).toEqual(edges.map((e) => e.id));
  });

  it('lets the same connector belong to two different flows at different positions', () => {
    const { edges } = chain(3);
    const happy = store.getState().createFlow('Happy path');
    const retry = store.getState().createFlow('Retry');

    store.getState().addEdgeToFlow(happy, edges[0]!.id);
    store.getState().addEdgeToFlow(happy, edges[1]!.id);
    store.getState().addEdgeToFlow(retry, edges[1]!.id);
    store.getState().addEdgeToFlow(retry, edges[0]!.id);

    const doc = store.getState().document;
    const happyFlow = doc.flows.find((f) => f.id === happy)!;
    const retryFlow = doc.flows.find((f) => f.id === retry)!;
    expect(stepIndexOf(happyFlow, edges[0]!.id)).toBe(1);
    expect(stepIndexOf(happyFlow, edges[1]!.id)).toBe(2);
    expect(stepIndexOf(retryFlow, edges[1]!.id)).toBe(1);
    expect(stepIndexOf(retryFlow, edges[0]!.id)).toBe(2);
  });

  it('reorders a step earlier or later', () => {
    const { edges } = chain(3);
    const flowId = store.getState().createFlow();
    for (const edge of edges) store.getState().addEdgeToFlow(flowId, edge.id);
    const steps = store.getState().document.flows[0]!.steps;

    store.getState().moveFlowStep(flowId, steps[2]!.id, -1);
    expect(store.getState().document.flows[0]!.steps.map((s) => s.edgeId)).toEqual([
      edges[0]!.id,
      edges[2]!.id,
      edges[1]!.id,
    ]);
  });

  it('removes a step without affecting other flows referencing the same connector', () => {
    const { edges } = chain(2);
    const a = store.getState().createFlow('A');
    const b = store.getState().createFlow('B');
    store.getState().addEdgeToFlow(a, edges[0]!.id);
    store.getState().addEdgeToFlow(b, edges[0]!.id);

    const stepId = store.getState().document.flows.find((f) => f.id === a)!.steps[0]!.id;
    store.getState().removeFlowStep(a, stepId);

    const doc = store.getState().document;
    expect(doc.flows.find((f) => f.id === a)!.steps).toEqual([]);
    expect(doc.flows.find((f) => f.id === b)!.steps).toHaveLength(1);
  });

  it('drops a flow step when its connector is deleted, leaving the rest in order', () => {
    const { edges } = chain(3);
    const flowId = store.getState().createFlow();
    for (const edge of edges) store.getState().addEdgeToFlow(flowId, edge.id);

    store.getState().setSelection({ nodes: [], edges: [edges[1]!.id] });
    store.getState().deleteSelection();

    const flow = store.getState().document.flows[0]!;
    expect(flow.steps.map((s) => s.edgeId)).toEqual([edges[0]!.id, edges[2]!.id]);
  });

  it('resets playback and the selected flow when the presented flow is deleted', () => {
    const { edges } = chain(1);
    const flowId = store.getState().createFlow();
    store.getState().addEdgeToFlow(flowId, edges[0]!.id);
    store.getState().setSelectedFlowId(flowId);
    store.getState().setFlowPlayback({ active: true, flowId, step: 1 });

    store.getState().deleteFlow(flowId);

    expect(store.getState().selectedFlowId).toBeNull();
    expect(store.getState().flowPlayback).toEqual({ active: false, flowId: null, step: 0 });
  });

  it('opening a document auto-selects its one flow, so step badges are not blank on first load', () => {
    const doc = addFlow(createDocument('X'), createFlow({ title: 'Only flow', id: 'f1' }));
    store.getState().setDocument(doc);
    expect(store.getState().selectedFlowId).toBe('f1');
  });

  it('opening a document with several flows selects none — guessing wrong would be worse', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = addFlow(doc, createFlow({ title: 'B', id: 'f2' }));
    store.getState().setDocument(doc);
    expect(store.getState().selectedFlowId).toBeNull();
  });

  it('opening a document with no flows selects none', () => {
    store.getState().setDocument(createDocument('X'));
    expect(store.getState().selectedFlowId).toBeNull();
  });

  it('supports undoing a flow creation and a step addition', () => {
    const { edges } = chain(1);
    const before = store.getState().history.past.length;
    const flowId = store.getState().createFlow();
    store.getState().addEdgeToFlow(flowId, edges[0]!.id);
    expect(store.getState().history.past.length).toBe(before + 2);

    store.getState().undo();
    expect(store.getState().document.flows[0]!.steps).toEqual([]);
    store.getState().undo();
    expect(store.getState().document.flows).toEqual([]);
  });

  it('coalesces rapid flow renames into one undo step', () => {
    const flowId = store.getState().createFlow('A');
    const before = store.getState().history.past.length;
    store.getState().renameFlow(flowId, 'Ha');
    store.getState().renameFlow(flowId, 'Happ');
    store.getState().renameFlow(flowId, 'Happy path');
    expect(store.getState().history.past.length).toBe(before + 1);
    expect(store.getState().document.flows[0]!.title).toBe('Happy path');
  });

  it('never touches history when playback or the selected flow overlay changes', () => {
    const { edges } = chain(1);
    const flowId = store.getState().createFlow();
    store.getState().addEdgeToFlow(flowId, edges[0]!.id);
    const before = store.getState().history.past.length;

    store.getState().setSelectedFlowId(flowId);
    store.getState().setFlowPlayback({ active: true, flowId, step: 1 });
    store.getState().setFlowPlayback({ active: false });

    expect(store.getState().history.past.length).toBe(before);
  });
});

describe('operations.ts removeElements cascade', () => {
  it('prunes flow steps when removeElements drops an edge via a removed node', () => {
    const { nodes, edges } = chain(2);
    const flowId = 'f1';
    let doc = addFlow(store.getState().document, createFlow({ title: 'A', id: flowId }));
    doc = addStepToFlow(doc, flowId, edges[0]!.id);
    doc = addStepToFlow(doc, flowId, edges[1]!.id);

    const next = removeElements(doc, [nodes[1]!.id]);
    expect(next.flows[0]!.steps.map((s) => s.edgeId)).toEqual([]);
  });
});

describe('v1 to v2 migration', () => {
  it('synthesizes a single Walkthrough flow from legacy edge.sequence numbers', () => {
    const raw = {
      format: DRAFT_FORMAT,
      version: 1,
      metadata: { id: 'd1', title: 'Old', createdAt: 0, updatedAt: 0 },
      nodes: [
        { id: 'a', type: 'card', x: 0, y: 0 },
        { id: 'b', type: 'card', x: 100, y: 0 },
        { id: 'c', type: 'card', x: 200, y: 0 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', sequence: 5 },
        { id: 'e2', source: 'b', target: 'c', sequence: 2 },
        { id: 'e3', source: 'c', target: 'a' },
      ],
    };

    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Always migrates all the way to the current format, not just to v2 —
    // this fixture also exercises the later v2→v3 anchor migration below.
    expect(result.document.version).toBe(CURRENT_VERSION);
    expect(result.document.flows).toHaveLength(1);
    expect(result.document.flows[0]!.title).toBe('Walkthrough');
    // Relative order preserved: the edge numbered 2 becomes step 1.
    expect(result.document.flows[0]!.steps.map((s) => s.edgeId)).toEqual(['e2', 'e1']);
    // The legacy field is gone from the normalized edges.
    expect(result.document.edges.every((e) => !('sequence' in e))).toBe(true);
  });

  it('produces no flow when nothing was sequenced', () => {
    const raw = {
      format: DRAFT_FORMAT,
      version: 1,
      metadata: { id: 'd1', title: 'Old', createdAt: 0, updatedAt: 0 },
      nodes: [{ id: 'a', type: 'card', x: 0, y: 0 }],
      edges: [],
    };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows).toEqual([]);
  });
});
