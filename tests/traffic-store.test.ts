import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createFlow } from '../src/document/flow';
import type { DraftDocument, DraftEdge, DraftNode } from '../src/document/types';
import {
  __resetInteraction,
  lensFlow,
  TRAFFIC_OFF,
  useEditorStore,
} from '../src/store/editorStore';
import {
  roomMayHaveTraffic,
  trafficEdgeOf,
  trafficNodeReading,
  trafficOf,
} from '../src/store/traffic';

const preferences = new Map<string, string>();

vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
  removePreference: (key: string) => void preferences.delete(key),
}));

const store = useEditorStore;

function documentWith(nodes: DraftNode[], edges: DraftEdge[] = [], title = 'Traffic'): DraftDocument {
  return { ...createDocument(title), nodes, edges };
}

function service(id: string, text = id, serviceKind: DraftNode['serviceKind'] = 'generic'): DraftNode {
  return createNode({ id, type: 'service', serviceKind, text, x: 0, y: 0 });
}

function database(id: string, text = id): DraftNode {
  return createNode({ id, type: 'database', databaseKind: 'sql', text, x: 0, y: 0 });
}

function edge(id: string, source: string, target: string, semantic: DraftEdge['semantic']): DraftEdge {
  return createEdge({ id, source, target, semantic });
}

function reset(document = createDocument('Traffic')) {
  __resetInteraction();
  store.setState({
    document,
    path: [],
    outer: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    pasteRepeat: 0,
    save: { status: 'idle' },
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    editReturn: null,
    focus: { active: false, nodeIds: [], edgeIds: [] },
    traffic: TRAFFIC_OFF,
    selectedFlowId: null,
    revision: 0,
    liveViewport: null,
  });
  preferences.clear();
}

beforeEach(() => reset());

describe('traffic view state', () => {
  it('shows and hides without touching the document, revision, history, or save state', () => {
    const before = store.getState();
    const document = before.document;
    const history = before.history;
    const save = before.save;
    const revision = before.revision;

    before.showTraffic();
    expect(store.getState().traffic).toEqual({ active: true, flowId: null });
    expect(store.getState().document).toBe(document);
    expect(store.getState().history).toBe(history);
    expect(store.getState().save).toBe(save);
    expect(store.getState().revision).toBe(revision);

    store.getState().hideTraffic();
    expect(store.getState().traffic).toEqual(TRAFFIC_OFF);
    expect(store.getState().document).toBe(document);
    expect(store.getState().history).toBe(history);
    expect(store.getState().save).toBe(save);
    expect(store.getState().revision).toBe(revision);
  });

  it('turns off the flow lens while traffic is active', () => {
    const source = service('source');
    const target = service('target');
    const connector = edge('calls', source.id, target.id, 'calls');
    const flow = createFlow({ id: 'checkout', title: 'Checkout' });
    flow.steps = [{ id: 'step', edgeId: connector.id }];
    reset({ ...documentWith([source, target], [connector]), flows: [flow] });

    store.getState().setSelectedFlowId(flow.id);
    expect(lensFlow(store.getState())?.id).toBe(flow.id);
    store.getState().showTraffic(flow.id);

    expect(store.getState().traffic).toEqual({ active: true, flowId: flow.id });
    expect(lensFlow(store.getState())).toBeUndefined();
  });

  it('scopes to an existing flow and falls back to the whole room for an unknown id', () => {
    const source = service('source');
    const target = service('target');
    const connector = edge('calls', source.id, target.id, 'calls');
    const flow = createFlow({ id: 'checkout', title: 'Checkout' });
    flow.steps = [{ id: 'step', edgeId: connector.id }];
    reset({ ...documentWith([source, target], [connector]), flows: [flow] });

    store.getState().showTraffic(flow.id);
    expect(store.getState().traffic.flowId).toBe(flow.id);

    store.getState().showTraffic('missing-flow');
    expect(store.getState().traffic).toEqual({ active: true, flowId: null });
  });

  it('clears traffic when the document or a competing view lifecycle starts', () => {
    const source = service('source');
    const target = service('target');
    const connector = edge('calls', source.id, target.id, 'calls');
    const first = documentWith([source, target], [connector], 'First');
    reset(first);

    store.getState().showTraffic();
    store.getState().setDocument(createDocument('Second'));
    expect(store.getState().traffic).toEqual(TRAFFIC_OFF);

    store.getState().setDocument(first);
    store.getState().showTraffic();
    store.getState().setMode('present');
    expect(store.getState().traffic).toEqual(TRAFFIC_OFF);
    store.getState().showTraffic();
    expect(store.getState().traffic).toEqual(TRAFFIC_OFF);

    store.getState().setMode('edit');
    store.getState().showTraffic();
    store.getState().setFlowPlayback({ active: true, flowId: null, step: 0 });
    expect(store.getState().traffic).toEqual(TRAFFIC_OFF);

    store.getState().setFlowPlayback({ active: false, flowId: null, step: 0 });
    store.getState().showTraffic();
    store.getState().enterFocus([source.id], [connector.id]);
    expect(store.getState().traffic).toEqual(TRAFFIC_OFF);

    store.getState().showTraffic();
    expect(store.getState().focus.active).toBe(false);
    expect(store.getState().traffic.active).toBe(true);
  });
});

describe('traffic selectors and memoization', () => {
  it('memoizes semantic-equivalent node arrays but invalidates analysis for graph edits and undo/redo', () => {
    const source = service('source', 'Gateway', 'gateway');
    const middle = service('middle', 'Order Service');
    const data = database('data', 'Postgres');
    const calls = edge('calls', source.id, middle.id, 'calls');
    const reads = edge('reads', middle.id, data.id, 'readsWrites');
    reset(documentWith([source, middle, data], [calls, reads]));
    store.getState().showTraffic();

    const initial = trafficOf(store.getState());
    expect(initial).not.toBeNull();
    expect(trafficOf(store.getState())).toBe(initial);

    const nodesBeforeMove = store.getState().document.nodes;
    store.getState().updateNodeById(source.id, { x: 240 }, 'Move');
    expect(store.getState().document.nodes).not.toBe(nodesBeforeMove);
    expect(trafficOf(store.getState())).toBe(initial);

    store.getState().updateNodeText(middle.id, 'Renamed Service');
    const renamed = trafficOf(store.getState());
    expect(renamed).not.toBe(initial);

    store.getState().updateNodeById(middle.id, { serviceKind: 'worker' }, 'Change kind');
    const changedKind = trafficOf(store.getState());
    expect(changedKind).not.toBe(renamed);

    const extra = store.getState().addNode({ type: 'service', id: 'extra', text: 'Extra', x: 400, y: 0 });
    const extraEdge = store.getState().connect(extra.id, data.id)!;
    const withExtraEdge = trafficOf(store.getState());
    expect(withExtraEdge).not.toBe(changedKind);

    store.getState().setSelection({ nodes: [], edges: [extraEdge.id] });
    store.getState().deleteSelection();
    const withoutExtraEdge = trafficOf(store.getState());
    expect(withoutExtraEdge).not.toBe(withExtraEdge);

    store.getState().setSelection({ nodes: [middle.id], edges: [] });
    store.getState().deleteSelection();
    const afterDelete = trafficOf(store.getState())!;
    expect(afterDelete).not.toBe(withoutExtraEdge);
    expect(afterDelete.nodes.has(middle.id)).toBe(false);

    store.getState().undo();
    const afterUndo = trafficOf(store.getState())!;
    expect(afterUndo).not.toBe(afterDelete);
    expect(afterUndo.nodes.has(middle.id)).toBe(true);

    store.getState().redo();
    const afterRedo = trafficOf(store.getState())!;
    expect(afterRedo).not.toBe(afterUndo);
    expect(afterRedo.nodes.has(middle.id)).toBe(false);
  });

  it('returns null while inactive and exposes the expected node and edge readings', () => {
    const source = service('source');
    const junction = createNode({ id: 'junction', type: 'ellipse', x: 0, y: 0 });
    const target = service('target');
    const component = createNode({ id: 'component', type: 'component', x: 0, y: 0 });
    const structural = edge('structural', source.id, target.id, 'dependsOn');
    const routedIn = edge('routed-in', source.id, junction.id, 'calls');
    const routedOut = edge('routed-out', junction.id, target.id, 'calls');
    reset(documentWith([source, junction, target, component], [structural, routedIn, routedOut]));

    expect(trafficOf(store.getState())).toBeNull();
    store.getState().showTraffic();

    expect(trafficNodeReading(store.getState(), junction.id)).toBe('lit');
    expect(trafficNodeReading(store.getState(), junction.id)).not.toBe('top');
    expect(trafficNodeReading(store.getState(), junction.id)).not.toBe('raised');
    expect(trafficNodeReading(store.getState(), component.id)).toBe('dim');
    expect(trafficEdgeOf(store.getState(), structural.id)).toBe('none');
  });

  it('ranks a data store top when three services converge on it', () => {
    const services = [service('one'), service('two'), service('three')];
    const data = database('postgres', 'Postgres');
    const edges = services.map((item, index) => edge(`reads-${index}`, item.id, data.id, 'readsWrites'));
    reset(documentWith([...services, data], edges));
    store.getState().showTraffic();

    expect(trafficNodeReading(store.getState(), data.id)).toBe('top');
  });
});

describe('roomMayHaveTraffic', () => {
  it('is false for notes-only rooms and true for a service-to-database route', () => {
    const note = createNode({ id: 'note', type: 'note', text: 'Just a note', x: 0, y: 0 });
    reset(documentWith([note]));
    expect(roomMayHaveTraffic(store.getState())).toBe(false);

    const source = service('source');
    const data = database('data');
    reset(documentWith([source, data], [edge('reads', source.id, data.id, 'readsWrites')]));
    expect(roomMayHaveTraffic(store.getState())).toBe(true);
  });
});
