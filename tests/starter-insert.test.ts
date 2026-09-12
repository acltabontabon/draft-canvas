import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { createFlow, flowHasMembers } from '../src/document/flow';
import { LIMITS } from '../src/document/limits';
import { boundsOf, freeOriginFor, INSERT_GAP } from '../src/document/operations';
import type { Bounds } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { ARCHITECTURE_STARTERS, starterById, starterSize } from '../src/starters';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/** Inserting a starter is the one action in the app that puts a whole diagram on the canvas at
 *  once. What matters is that it behaves like every other edit: one undo step, nothing existing
 *  moved, and nothing landing on top of anything. */

const store = useEditorStore;

function reset() {
  __resetInteraction();
  store.setState({
    document: createDocument('Starters'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
  });
}

const intersects = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('insertStarter', () => {
  beforeEach(reset);

  it.each(ARCHITECTURE_STARTERS.map((s) => [s.name, s] as const))(
    'puts %s on an empty canvas and selects it',
    (_label, starter) => {
      const created = store.getState().insertStarter(starter);
      const state = store.getState();
      expect(created).toHaveLength(starter.nodes.length);
      expect(state.document.nodes).toHaveLength(starter.nodes.length);
      expect(state.document.edges).toHaveLength(starter.edges.length);
      expect(state.selection.nodes).toEqual(created.map((node) => node.id));
      expect(state.selection.edges).toEqual([]);
      // Centred on the origin, so the very first thing a user inserts appears where they are
      // already looking rather than off in a corner.
      const bounds = boundsOf(state.document.nodes)!;
      expect(Math.abs(bounds.x + bounds.width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.y + bounds.height / 2)).toBeLessThanOrEqual(1);
    },
  );

  it('is one undo step, and redo brings the whole architecture back', () => {
    const created = store.getState().insertStarter(starterById('microservices')!);
    expect(store.getState().history.past).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().document.nodes).toEqual([]);
    expect(store.getState().document.edges).toEqual([]);

    store.getState().redo();
    const after = store.getState();
    expect(after.document.nodes.map((node) => node.id)).toEqual(created.map((node) => node.id));
    expect(after.document.edges).toHaveLength(9);
    expect(after.selection.nodes).toEqual(created.map((node) => node.id));
  });

  it('leaves existing content exactly where it was', () => {
    const existing = store.getState().addNode({ type: 'note', x: 40, y: 40, text: 'mine' });
    const before = store.getState().document.nodes.map((node) => ({ ...node }));

    store.getState().insertStarter(starterById('monolith')!);

    const after = store.getState().document.nodes.filter((node) => node.id === existing.id);
    expect(after).toEqual(before);
  });

  it('never drops a second starter on top of the first', () => {
    const first = boundsOf(store.getState().insertStarter(starterById('microservices')!))!;
    const second = boundsOf(store.getState().insertStarter(starterById('microservices')!))!;
    expect(intersects(first, second)).toBe(false);
    expect(second.x).toBeGreaterThanOrEqual(first.x + first.width + INSERT_GAP);
    // Both are still whole: nothing was merged, nothing reused an id.
    expect(store.getState().document.nodes).toHaveLength(24);
    expect(store.getState().document.edges).toHaveLength(18);
    expect(new Set(store.getState().document.nodes.map((node) => node.id)).size).toBe(24);
  });

  it('clears one starter at a time, newest first', () => {
    store.getState().insertStarter(starterById('monolith')!);
    store.getState().insertStarter(starterById('event-driven')!);
    expect(store.getState().document.nodes).toHaveLength(18);
    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(7);
    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(0);
  });

  it.each(ARCHITECTURE_STARTERS.filter((s) => s.flows?.length).map((s) => [s.name, s] as const))(
    'ships %s with its predefined flows, every step pointing at a live connector',
    (_label, starter) => {
      store.getState().insertStarter(starter);
      const doc = store.getState().document;
      expect(doc.flows.map((flow) => flow.title)).toEqual(starter.flows!.map((flow) => flow.title));
      const edgeIds = new Set(doc.edges.map((edge) => edge.id));
      doc.flows.forEach((flow, index) => {
        expect(flow.steps).toHaveLength(starter.flows![index]!.steps.length);
        expect(flowHasMembers(doc, flow)).toBe(true);
        for (const step of flow.steps) expect(edgeIds.has(step.edgeId!)).toBe(true);
        expect(flow.accent).toBe(starter.flows![index]!.accent);
      });
    },
  );

  it('takes the flows out with one undo and brings them back with one redo', () => {
    store.getState().insertStarter(starterById('saga-orchestration')!);
    expect(store.getState().history.past).toHaveLength(1);
    const flows = store.getState().document.flows;
    expect(flows).toHaveLength(2);

    store.getState().undo();
    expect(store.getState().document.flows).toEqual([]);
    expect(store.getState().document.nodes).toEqual([]);

    store.getState().redo();
    expect(store.getState().document.flows).toEqual(flows);
  });

  it('inserts the same starter twice with two independent sets of flows', () => {
    store.getState().insertStarter(starterById('cqrs')!);
    store.getState().insertStarter(starterById('cqrs')!);
    const doc = store.getState().document;
    expect(doc.flows).toHaveLength(4);
    expect(new Set(doc.flows.map((flow) => flow.id)).size).toBe(4);
    const stepIds = doc.flows.flatMap((flow) => flow.steps.map((step) => step.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
    // The second copy's flows walk the second copy's connectors, not the first's.
    const stepEdges = (flow: (typeof doc.flows)[number]) => flow.steps.map((step) => step.edgeId);
    expect(stepEdges(doc.flows[0]!).some((id) => stepEdges(doc.flows[2]!).includes(id))).toBe(false);
  });

  it('leaves existing flows alone, and still inserts the diagram when the flow cap is already reached', () => {
    const mine = createFlow({ title: 'Mine' });
    store.setState((state) => ({ document: { ...state.document, flows: [mine] } }));
    store.getState().insertStarter(starterById('transactional-outbox')!);
    expect(store.getState().document.flows[0]).toEqual(mine);
    expect(store.getState().document.flows).toHaveLength(4);

    reset();
    const full = Array.from({ length: LIMITS.maxFlows }, (_, i) => createFlow({ title: `Flow ${i}` }));
    store.setState((state) => ({ document: { ...state.document, flows: full } }));
    const created = store.getState().insertStarter(starterById('transactional-outbox')!);
    expect(created).toHaveLength(8);
    expect(store.getState().document.flows).toHaveLength(LIMITS.maxFlows);
  });

  it('keeps its flows through a save and reopen', () => {
    store.getState().insertStarter(starterById('saga-orchestration')!);
    const before = store.getState().document;
    const result = parseDocument(JSON.stringify(before));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    expect(result.document.flows).toEqual(before.flows);
    expect(result.document.edges.map((edge) => [edge.id, edge.semantic, edge.semanticsOrigin])).toEqual(
      before.edges.map((edge) => [edge.id, edge.semantic, edge.semanticsOrigin]),
    );
  });

});

describe('freeOriginFor', () => {
  beforeEach(reset);

  it('centres the first block on the origin', () => {
    const origin = freeOriginFor(createDocument('x'), { width: 400, height: 200 });
    expect(origin).toEqual({ x: -200, y: -100 });
  });

  it('treats a boundary as an obstacle, unlike placeNear', () => {
    // `placeNear` deliberately lands a companion node *inside* a boundary; a whole architecture
    // dropped into someone else's boundary would just look like a mistake.
    store.getState().addNode({ type: 'group', x: 0, y: 0, width: 600, height: 400 });
    const origin = freeOriginFor(store.getState().document, { width: 300, height: 300 });
    expect(origin.x).toBe(600 + INSERT_GAP);
  });

  it('goes below instead of right when the canvas is already at the coordinate limit', () => {
    store.getState().addNode({ type: 'note', x: 999_000, y: 0, width: 200, height: 100 });
    const origin = freeOriginFor(store.getState().document, { width: 4000, height: 300 });
    expect(origin.y).toBe(100 + INSERT_GAP);
    expect(origin.x).toBe(999_000);
  });

  it('agrees with the size the starter actually builds to', () => {
    for (const starter of ARCHITECTURE_STARTERS) {
      reset();
      const created = store.getState().insertStarter(starter);
      const bounds = boundsOf(created)!;
      expect({ width: bounds.width, height: bounds.height }).toEqual(starterSize(starter));
    }
  });
});

describe('a starter after insertion is an ordinary diagram', () => {
  beforeEach(reset);

  it('can be edited, regrouped and deleted like anything else', () => {
    const created = store.getState().insertStarter(starterById('microservices')!);
    const service = created.find((node) => node.text === 'Orders')!;

    store.getState().updateNodeText(service.id, 'Fulfilment');
    expect(store.getState().document.nodes.find((n) => n.id === service.id)!.text).toBe('Fulfilment');

    // Nothing marks these as belonging to a starter, so pulling one out of its boundary is just a
    // reparent — there is no "starter object" to keep consistent.
    store.getState().reparentNode(service.id, null);
    expect(store.getState().document.nodes.find((n) => n.id === service.id)!.parentId).toBeUndefined();

    store.getState().setSelection({ nodes: [service.id], edges: [] });
    store.getState().deleteSelection();
    expect(store.getState().document.nodes.some((n) => n.id === service.id)).toBe(false);
  });

  it('re-derives a connector when the node it points at changes kind', () => {
    const created = store.getState().insertStarter(starterById('monolith')!);
    const database = created.find((node) => node.type === 'database')!;
    store.getState().updateNodeById(database.id, { databaseKind: 'cache' });
    const edge = store.getState().document.edges.find((e) => e.target === database.id)!;
    // Still `writes` for a cache, but it went back through the matrix rather than staying frozen.
    expect(edge.semantic).toBe('writes');
    expect(edge.semanticsOrigin).toBe('inferred');
  });

  it('keeps every starter within the document limits it will be validated against', () => {
    for (const starter of ARCHITECTURE_STARTERS) {
      reset();
      store.getState().insertStarter(starter);
      for (const node of store.getState().document.nodes) {
        expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
        expect(node.width).toBeGreaterThanOrEqual(24);
        expect(node.height).toBeGreaterThanOrEqual(24);
      }
    }
  });
});
