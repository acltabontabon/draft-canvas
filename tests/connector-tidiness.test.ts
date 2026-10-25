import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, reconnectEdge } from '../src/document/operations';
import { reconnectProblem } from '../src/document/reconnect';
import { routeBetween, routeEdge, runsThroughEnds } from '../src/edges/routing';
import { labelChipBox } from '../src/edges/labelGroups';
import { edgeLabelSize } from '../src/edges/labelLayout';
import { describeEdge } from '../src/edges/describe';
import { edgeLabelPoint } from '../src/canvas/edgeGeometry';
import { getMeasurer } from '../src/render/text/measure';
import { LIGHT } from '../src/render/theme/tokens';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { commandsFor } from '../src/commands/registry';
import { stubContext } from './commandStubs';

const source = { x: 0, y: 0, width: 160, height: 80 };
const target = { x: 600, y: 0, width: 160, height: 80 };
const nowhere = { x: 10000, y: 10000, width: 1, height: 1 };
const rotate = (r: typeof source) => ({ x: r.y, y: r.x, width: r.height, height: r.width });

describe('connector obstacle regressions', () => {
  it.each([false, true])('checks the whole detour against a second obstacle, rotated=%s', (vertical) => {
    const transform = vertical ? rotate : (r: typeof source) => r;
    const obstacles = [
      { x: 300, y: 0, width: 160, height: 80 },
      { x: 200, y: -50, width: 80, height: 50 },
      // The first vertical leg of the old upper detour crossed this one too.
      { x: 170, y: 0, width: 40, height: 15 },
    ].map(transform);
    const route = routeBetween(transform(source), transform(target), 'smoothstep', { obstacles });
    for (const obstacle of obstacles) expect(runsThroughEnds(route.d, obstacle, nowhere)).toBe(false);
    expect(runsThroughEnds(route.d, transform(source), transform(target))).toBe(false);
  });

  it('finds a clear outer corridor when both initial detours are blocked', () => {
    const obstacles = [
      { x: 300, y: 0, width: 160, height: 80 },
      { x: 200, y: -50, width: 80, height: 50 },
      { x: 220, y: 80, width: 60, height: 60 },
    ];
    const route = routeBetween(source, target, 'smoothstep', { obstacles });
    for (const obstacle of obstacles) expect(runsThroughEnds(route.d, obstacle, nowhere)).toBe(false);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])('keeps the full label clear, both sides blocked=%s, manual bends=%s', (both, manual) => {
    const a = createNode({ id: 'a', type: 'service', ...source });
    const b = createNode({ id: 'b', type: 'service', ...target });
    const blocker = createNode({ id: 'block', type: 'service', x: 330, y: 0, width: 100, height: 29 });
    const lower = createNode({ id: 'lower', type: 'service', x: 330, y: 50, width: 100, height: 50 });
    const nodes = [a, b, blocker, ...(both ? [lower] : [])];
    const obstacles = nodes.slice(2);
    const edge = createEdge({ source: a.id, target: b.id, label: 'Payment requested', ...(manual ? { waypoints: [{ x: 300, y: 40 }, { x: 460, y: 40 }] } : {}) });
    const route = routeEdge(edge, new Map(nodes.map((node) => [node.id, node])), { obstacles })!;
    const size = edgeLabelSize(edge.label!);
    const chip = labelChipBox(route.labelSide, route.labelX, route.labelY, size.width, size.height);
    for (const node of nodes) {
      expect(chip.x < node.x + node.width && chip.x + chip.width > node.x && chip.y < node.y + node.height && chip.y + chip.height > node.y).toBe(false);
    }
    expect(route.d).toBe(routeBetween(source, target, edge.routing, { waypoints: edge.waypoints }).d);
    const exported = describeEdge(edge, new Map(nodes.map((node) => [node.id, node])), {
      theme: LIGHT, measurer: getMeasurer(), showSequence: false, obstacles,
    })!;
    expect(exported.route).toEqual(route);
    expect(edgeLabelPoint({ nodes, edges: [edge] }, edge, source, target)).toEqual({ x: route.labelX, y: route.labelY, side: route.labelSide });
  });
});

describe('connector action consistency', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({ document: createDocument('Connectors'), path: [], outer: null,
      history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, selectedFlowId: null });
    useUiStore.setState({ toasts: [] });
  });

  function services() {
    const a = createNode({ id: 'a', type: 'service', ...source });
    const b = createNode({ id: 'b', type: 'service', ...target });
    const c = createNode({ id: 'c', type: 'service', x: 600, y: 200 });
    const edge = { ...createEdge({ id: 'edge', source: a.id, target: b.id, semantic: 'calls', hasResponse: true }), response: 'Accepted' };
    const duplicate = createEdge({ id: 'duplicate', source: a.id, target: c.id });
    const document = addEdges(addNodes(createDocument('Connectors'), [a, b, c]), [edge, duplicate]);
    useEditorStore.setState({ document, selection: { nodes: [], edges: [edge.id] } });
    return { document, edge, a, b, c };
  }

  it('context and inspector actions share mode, response policy and undo', () => {
    const { edge } = services();
    const command = commandsFor(stubContext()).find((item) => item.id === 'edge-async')!;
    expect(command.title).toBe('Make asynchronous');
    command.run(stubContext());
    let current = useEditorStore.getState().document.edges[0]!;
    expect(current).toMatchObject({ kind: 'async', response: 'Accepted' });
    expect(current.async).toBeUndefined(); // Keep service request strokes independent of mode.
    expect(current.hasResponse).toBeUndefined();
    expect(commandsFor(stubContext()).find((item) => item.id === 'edge-async')!.title).toBe('Make synchronous');
    expect(commandsFor(stubContext()).some((item) => item.id === 'edge-response')).toBe(false);
    useEditorStore.getState().setEdgeHasResponse(edge.id, true);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().document.edges[0]).toEqual(edge);
    useEditorStore.getState().redo();
    useEditorStore.getState().setEdgeInteractionMode(edge.id, 'sync');
    current = useEditorStore.getState().document.edges[0]!;
    expect(current.kind).toBeUndefined();
    expect(current.response).toBe('Accepted');
    expect(commandsFor(stubContext()).some((item) => item.id === 'edge-response')).toBe(true);
  });

  it('adds a useful HTTP reply in the same undo step and keeps later edits when hidden', () => {
    const a = createNode({ id: 'orders', type: 'service', ...source });
    const b = createNode({ id: 'inventory', type: 'service', ...target });
    const request = createEdge({ id: 'reserve', source: a.id, target: b.id, semantic: 'http', label: 'POST /reservations' });
    const document = addEdges(addNodes(createDocument('Reservation'), [a, b]), [request]);
    useEditorStore.setState({ document });

    useEditorStore.getState().setEdgeHasResponse(request.id, true);
    expect(useEditorStore.getState().document.edges[0]).toMatchObject({ hasResponse: true, response: '201 Created' });
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().document.edges[0]?.response).toBeUndefined();
    useEditorStore.getState().redo();

    useEditorStore.getState().setEdgeResponse(request.id, '202 Accepted');
    useEditorStore.getState().setEdgeHasResponse(request.id, false);
    useEditorStore.getState().setEdgeHasResponse(request.id, true);
    expect(useEditorStore.getState().document.edges[0]?.response).toBe('202 Accepted');
  });

  it('rejects duplicate reconnects with feedback, no history entry and no palette target', () => {
    const { document, edge, c } = services();
    expect(reconnectProblem(document, edge, 'target', c.id)).toBe('duplicate');
    expect(reconnectEdge(document, edge.id, 'target', c.id, undefined)).toBe(document);
    useEditorStore.getState().reconnectEdge(edge.id, 'target', c.id, undefined);
    expect(useEditorStore.getState().document).toBe(document);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Already connected to that shape.');
    const stage = commandsFor(stubContext()).find((item) => item.id === 'edge-reconnect-target')!.run(stubContext());
    expect(stage && 'options' in stage ? stage.options.some((item) => item.id.endsWith(c.id)) : true).toBe(false);
  });

  it('still allows re-siding a connector when the pair already has a parallel edge', () => {
    const { document, edge, b } = services();
    const parallel = createEdge({ source: edge.source, target: edge.target });
    const doc = { ...document, edges: [...document.edges, parallel] };
    expect(reconnectProblem(doc, edge, 'target', b.id)).toBeUndefined();
    expect(reconnectEdge(doc, edge.id, 'target', b.id, 'bottom').edges[0]!.targetAnchor?.side).toBe('bottom');
  });
});
