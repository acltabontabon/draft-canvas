import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import {
  addFlow,
  addStepExtraEdge,
  addStepExtraNode,
  addStepToFlow,
  createFlow,
  deleteFlow,
  explainEdgeTier,
  explainNodeTier,
  lensEdgeTier,
  lensNodeTier,
  moveStepInFlow,
  pruneFlowSteps,
  removeStepExtraEdge,
  removeStepExtraNode,
  removeStepFromFlow,
  renameFlow,
  setFlowAccent,
  setStepViewport,
  stepIndexOf,
  updateFlowStepCaption,
} from '../src/document/flow';
import { removeElements } from '../src/document/operations';
import { resolveFlowStep, stepFocusBounds } from '../src/presentation/useFlowPlayback';
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

  it('sets and clears a flow accent, no-op for an unknown id or unchanged value', () => {
    const doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    const accented = setFlowAccent(doc, 'f1', 'violet');
    expect(accented.flows[0]!.accent).toBe('violet');
    expect(setFlowAccent(accented, 'f1', 'violet')).toBe(accented);
    const cleared = setFlowAccent(accented, 'f1', undefined);
    expect(cleared.flows[0]!.accent).toBeUndefined();
    expect(setFlowAccent(doc, 'missing', 'teal')).toBe(doc);
  });

  it('binary lens membership: a connector is either part of the flow or dimmed, no "no flow" crash', () => {
    const flow = createFlow({ title: 'X' });
    flow.steps = [{ id: 's1', edgeId: 'e1' }];
    expect(lensEdgeTier(flow, 'e1')).toBe('member');
    expect(lensEdgeTier(flow, 'missing')).toBe('dimmed');
    expect(lensEdgeTier(undefined, 'e1')).toBe('dimmed');
  });

  it('lens node tier: member via a member edge endpoint or a frame-step extraNodeIds listing', () => {
    const memberEdge = createEdge({ source: 'a', target: 'b', id: 'e1' });
    const otherEdge = createEdge({ source: 'c', target: 'd', id: 'e2' });
    const flow = createFlow({ title: 'X' });
    flow.steps = [
      { id: 's1', edgeId: 'e1' },
      { id: 's2', extraNodeIds: ['z'] },
    ];
    const edges = [memberEdge, otherEdge];
    expect(lensNodeTier(flow, edges, 'a')).toBe('member');
    expect(lensNodeTier(flow, edges, 'b')).toBe('member');
    expect(lensNodeTier(flow, edges, 'z')).toBe('member');
    expect(lensNodeTier(flow, edges, 'c')).toBe('dimmed');
    expect(lensNodeTier(undefined, edges, 'a')).toBe('dimmed');
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

  it('repairs, rather than drops, a step that still has something left after pruning', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, edges: [{ id: 'e1' }, { id: 'e2' }] as never };
    doc = addStepToFlow(doc, 'f1', 'e1');
    const stepId = doc.flows[0]!.steps[0]!.id;
    doc = { ...doc, flows: [{ ...doc.flows[0]!, steps: [{ ...doc.flows[0]!.steps[0]!, extraEdgeIds: ['e2'] }] }] };

    // The primary connector is removed, but `extraEdgeIds` still has `e2` —
    // the step survives with just that.
    const pruned = pruneFlowSteps(doc, new Set(['e1']));
    expect(pruned.flows[0]!.steps).toHaveLength(1);
    expect(pruned.flows[0]!.steps[0]!.edgeId).toBeUndefined();
    expect(pruned.flows[0]!.steps[0]!.extraEdgeIds).toEqual(['e2']);
    expect(pruned.flows[0]!.steps[0]!.id).toBe(stepId);

    // Remove both and the step is actually dropped.
    const goneToo = pruneFlowSteps(pruned, new Set(['e2']));
    expect(goneToo.flows[0]!.steps).toEqual([]);
  });

  it('prunes dangling extraNodeIds via the removedNodeIds set, keeping the step if extraEdgeIds remain', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, edges: [{ id: 'e1' }] as never };
    doc = {
      ...doc,
      flows: [
        { ...doc.flows[0]!, steps: [{ id: 's1', extraEdgeIds: ['e1'], extraNodeIds: ['n1', 'n2'] }] },
      ],
    };

    const pruned = pruneFlowSteps(doc, new Set(), new Set(['n1']));
    expect(pruned.flows[0]!.steps[0]!.extraNodeIds).toEqual(['n2']);
    expect(pruned.flows[0]!.steps[0]!.extraEdgeIds).toEqual(['e1']);

    // Losing every remaining node too, with nothing else left, drops the step.
    let onlyNodes = addFlow(createDocument('X'), createFlow({ title: 'B', id: 'f2' }));
    onlyNodes = {
      ...onlyNodes,
      flows: [{ ...onlyNodes.flows[0]!, steps: [{ id: 's1', extraNodeIds: ['n1'] }] }],
    };
    expect(pruneFlowSteps(onlyNodes, new Set(), new Set(['n1'])).flows[0]!.steps).toEqual([]);
  });

  it('finds a step via extraEdgeIds, not just the primary edgeId', () => {
    const flow = createFlow({ title: 'X' });
    flow.steps = [
      { id: 's1', edgeId: 'e1' },
      { id: 's2', extraEdgeIds: ['e2', 'e3'] },
    ];
    expect(stepIndexOf(flow, 'e2')).toBe(2);
    expect(stepIndexOf(flow, 'e3')).toBe(2);
  });

  it('lights up a node via extraNodeIds across every "frame" step it appears in', () => {
    const flow = createFlow({ title: 'X' });
    flow.steps = [
      { id: 's1', extraNodeIds: ['client'] },
      { id: 'p1', edgeId: 'unrelated' },
      { id: 's2', extraNodeIds: ['client'] },
    ];
    // Node appears in steps 1 and 3; at step 2 it should read as shown
    // (already covered by step 1), and at step 3 as active.
    expect(explainNodeTier(flow, [], 'client', 2)).toBe('shown');
    expect(explainNodeTier(flow, [], 'client', 3)).toBe('active');
    expect(explainNodeTier(flow, [], 'client', 1)).toBe('active');
    expect(explainNodeTier(flow, [], 'other', 3)).toBe('hidden');
  });

  it('adds and removes a step\'s extra nodes/edges, refusing ids that do not exist on the document', () => {
    const a = createNode({ type: 'note', x: 0, y: 0, id: 'a' });
    const b = createNode({ type: 'note', x: 100, y: 0, id: 'b' });
    const edge = createEdge({ source: 'a', target: 'b', id: 'e1' });
    let doc = { ...createDocument('X'), nodes: [a, b], edges: [edge] };
    doc = addFlow(doc, createFlow({ title: 'A', id: 'f1' }));
    doc = addStepToFlow(doc, 'f1', 'e1');
    const stepId = doc.flows[0]!.steps[0]!.id;

    doc = addStepExtraNode(doc, 'f1', stepId, 'b');
    expect(doc.flows[0]!.steps[0]!.extraNodeIds).toEqual(['b']);
    // Already a member, and a nonexistent node — both no-ops.
    expect(addStepExtraNode(doc, 'f1', stepId, 'b')).toBe(doc);
    expect(addStepExtraNode(doc, 'f1', stepId, 'nonexistent')).toBe(doc);

    doc = removeStepExtraNode(doc, 'f1', stepId, 'b');
    expect(doc.flows[0]!.steps[0]!.extraNodeIds).toBeUndefined();
    expect(removeStepExtraNode(doc, 'f1', stepId, 'b')).toBe(doc);
  });

  it('adds and removes a step\'s extra edges, refusing the step\'s own primary edge', () => {
    const edgeA = createEdge({ source: 'a', target: 'b', id: 'e1' });
    const edgeB = createEdge({ source: 'b', target: 'c', id: 'e2' });
    let doc = { ...createDocument('X'), edges: [edgeA, edgeB] };
    doc = addFlow(doc, createFlow({ title: 'A', id: 'f1' }));
    doc = addStepToFlow(doc, 'f1', 'e1');
    const stepId = doc.flows[0]!.steps[0]!.id;

    // The primary edge is already covered by `edgeId` — adding it as an
    // extra would be a redundant duplicate.
    expect(addStepExtraEdge(doc, 'f1', stepId, 'e1')).toBe(doc);

    doc = addStepExtraEdge(doc, 'f1', stepId, 'e2');
    expect(doc.flows[0]!.steps[0]!.extraEdgeIds).toEqual(['e2']);

    doc = removeStepExtraEdge(doc, 'f1', stepId, 'e2');
    expect(doc.flows[0]!.steps[0]!.extraEdgeIds).toBeUndefined();
  });

  it('caps a step\'s extra members at LIMITS.maxExtraMembersPerStep', () => {
    const nodes = Array.from({ length: 41 }, (_, i) => createNode({ type: 'note', x: i, y: 0, id: `n${i}` }));
    let doc = { ...createDocument('X'), nodes };
    doc = addFlow(doc, createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, flows: [{ ...doc.flows[0]!, steps: [{ id: 's1' }] }] };
    for (const node of nodes) doc = addStepExtraNode(doc, 'f1', 's1', node.id);
    expect(doc.flows[0]!.steps[0]!.extraNodeIds).toHaveLength(40);
  });

  it('sets and clears a step\'s explicit playback viewport', () => {
    let doc = addFlow(createDocument('X'), createFlow({ title: 'A', id: 'f1' }));
    doc = { ...doc, flows: [{ ...doc.flows[0]!, steps: [{ id: 's1' }] }] };

    doc = setStepViewport(doc, 'f1', 's1', { x: 10, y: 20, zoom: 1.5 });
    expect(doc.flows[0]!.steps[0]!.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });

    doc = setStepViewport(doc, 'f1', 's1', undefined);
    expect(doc.flows[0]!.steps[0]!.viewport).toBeUndefined();
    // Clearing an already-clear viewport is a no-op.
    expect(setStepViewport(doc, 'f1', 's1', undefined)).toBe(doc);
  });
});

describe('useFlowPlayback pure helpers', () => {
  it('resolves a legacy {id, edgeId, caption} step identically to before extras existed', () => {
    const edge = createEdge({ source: 'a', target: 'b', id: 'e1' });
    const edgesById = new Map([['e1', edge]]);
    const resolved = resolveFlowStep({ id: 's1', edgeId: 'e1', caption: 'Go' }, 0, 1, edgesById, new Map());
    expect(resolved).toEqual({
      edge,
      edges: [edge],
      extraNodes: [],
      index: 0,
      step: 1,
      caption: 'Go',
      viewport: undefined,
    });
  });

  it('resolves a multi-member step, filtering out dangling references', () => {
    const primary = createEdge({ source: 'a', target: 'b', id: 'e1' });
    const extra = createEdge({ source: 'c', target: 'd', id: 'e2' });
    const nodeC = createNode({ type: 'note', x: 0, y: 0, id: 'c' });
    const edgesById = new Map([['e1', primary], ['e2', extra]]);
    const nodesById = new Map([['c', nodeC]]);

    const resolved = resolveFlowStep(
      { id: 's1', edgeId: 'e1', extraEdgeIds: ['e2', 'gone'], extraNodeIds: ['c', 'gone'] },
      2,
      3,
      edgesById,
      nodesById,
    );
    expect(resolved?.edges).toEqual([primary, extra]);
    expect(resolved?.extraNodes).toEqual([nodeC]);
  });

  it('returns null for a step with nothing left to show', () => {
    const resolved = resolveFlowStep({ id: 's1', edgeId: 'gone' }, 0, 1, new Map(), new Map());
    expect(resolved).toBeNull();
  });

  it('keeps a frame step (no primary edge) with only extras', () => {
    const nodeA = createNode({ type: 'note', x: 0, y: 0, id: 'a' });
    const resolved = resolveFlowStep(
      { id: 's1', extraNodeIds: ['a'] },
      0,
      1,
      new Map(),
      new Map([['a', nodeA]]),
    );
    expect(resolved?.edge).toBeUndefined();
    expect(resolved?.extraNodes).toEqual([nodeA]);
  });

  it('computes focus bounds as the union of edge endpoints and extra nodes', () => {
    const a = createNode({ type: 'note', x: 0, y: 0, width: 100, height: 50, id: 'a' });
    const b = createNode({ type: 'note', x: 200, y: 100, width: 100, height: 50, id: 'b' });
    const c = createNode({ type: 'note', x: -50, y: -50, width: 20, height: 20, id: 'c' });
    const edge = createEdge({ source: 'a', target: 'b', id: 'e1' });
    const nodesById = new Map([['a', a], ['b', b], ['c', c]]);

    const step = resolveFlowStep({ id: 's1', edgeId: 'e1', extraNodeIds: ['c'] }, 0, 1, new Map([['e1', edge]]), nodesById)!;
    const bounds = stepFocusBounds(step, nodesById);
    expect(bounds).toEqual({ x: -50, y: -50, width: 350, height: 200 });
  });

  it('honors an explicit step viewport verbatim, distinct from any bounds computation', () => {
    const resolved = resolveFlowStep(
      { id: 's1', extraNodeIds: ['a'], viewport: { x: 5, y: 6, zoom: 2 } },
      0,
      1,
      new Map(),
      new Map(),
    );
    expect(resolved?.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
  });

  it('returns null bounds for a step with no resolvable members', () => {
    const step = resolveFlowStep({ id: 's1', viewport: { x: 0, y: 0, zoom: 1 } }, 0, 1, new Map(), new Map())!;
    expect(stepFocusBounds(step, new Map())).toBeNull();
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

  it('undoing a flow deletion restores which flow was selected and its playback state', () => {
    const { edges } = chain(1);
    const flowId = store.getState().createFlow();
    store.getState().addEdgeToFlow(flowId, edges[0]!.id);
    store.getState().setSelectedFlowId(flowId);
    store.getState().setFlowPlayback({ active: true, flowId, step: 1 });

    store.getState().deleteFlow(flowId);
    expect(store.getState().selectedFlowId).toBeNull();

    store.getState().undo();

    expect(store.getState().document.flows.find((f) => f.id === flowId)).toBeDefined();
    expect(store.getState().selectedFlowId).toBe(flowId);
    expect(store.getState().flowPlayback).toEqual({ active: true, flowId, step: 1 });

    store.getState().redo();

    expect(store.getState().document.flows.find((f) => f.id === flowId)).toBeUndefined();
    expect(store.getState().selectedFlowId).toBeNull();
    expect(store.getState().flowPlayback).toEqual({ active: false, flowId: null, step: 0 });
  });

  it('undoing a flow deletion restores flow-edit mode too, if it was active for that flow', () => {
    const { edges } = chain(1);
    const flowId = store.getState().createFlow();
    store.getState().addEdgeToFlow(flowId, edges[0]!.id);
    store.getState().enterFlowEdit(flowId);

    store.getState().deleteFlow(flowId);
    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });

    store.getState().undo();

    expect(store.getState().flowEdit).toEqual({ active: true, flowId });

    store.getState().redo();

    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });
  });

  it('does not disturb flow session state for an unrelated flow deletion', () => {
    const { edges } = chain(2);
    const kept = store.getState().createFlow('Kept');
    const removed = store.getState().createFlow('Removed');
    store.getState().addEdgeToFlow(kept, edges[0]!.id);
    store.getState().addEdgeToFlow(removed, edges[1]!.id);
    store.getState().setSelectedFlowId(kept);

    store.getState().deleteFlow(removed);
    expect(store.getState().selectedFlowId).toBe(kept);

    store.getState().undo();
    expect(store.getState().selectedFlowId).toBe(kept);
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

  it('sets a flow accent through the store, undoably', () => {
    const flowId = store.getState().createFlow('A');
    const before = store.getState().history.past.length;
    store.getState().setFlowAccent(flowId, 'amber');
    expect(store.getState().document.flows[0]!.accent).toBe('amber');
    expect(store.getState().history.past.length).toBe(before + 1);
    store.getState().undo();
    expect(store.getState().document.flows[0]!.accent).toBeUndefined();
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
        { id: 'a', type: 'note', x: 0, y: 0 },
        { id: 'b', type: 'note', x: 100, y: 0 },
        { id: 'c', type: 'note', x: 200, y: 0 },
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
      nodes: [{ id: 'a', type: 'note', x: 0, y: 0 }],
      edges: [],
    };
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.flows).toEqual([]);
  });
});
