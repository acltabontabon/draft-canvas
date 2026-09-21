import { beforeEach, describe, expect, it } from 'vitest';
import { edgeCommands } from '../src/commands/registry';
import type { CommandContext } from '../src/commands/types';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * A saga step's undo, drawn beside it: the one second connector allowed between a pair. Before
 * this, a drag refused it and the Interaction menu hid it, so a compensation only ever existed in
 * the Saga starter.
 */
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
    expect(twin).toMatchObject({ semantic: 'compensates', semanticsOrigin: 'explicit' });
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

  it('draws an explicit compensates twin beside the step, in one undo step, and selects it', () => {
    const { coordinator, participant, edge } = step();
    const before = store.getState().history.past.length;
    store.getState().addCompensation(edge.id);
    const edges = store.getState().document.edges;
    expect(store.getState().history.past).toHaveLength(before + 1);
    expect(edges).toHaveLength(2);
    const twin = edges.find((e) => e.id !== edge.id)!;
    expect(twin).toMatchObject({ source: coordinator.id, target: participant.id, semantic: 'compensates', semanticsOrigin: 'explicit' });
    expect(store.getState().selection).toEqual({ nodes: [], edges: [twin.id] });

    store.getState().undo();
    expect(store.getState().document.edges).toHaveLength(1);
  });

  it('never stacks a second undo — asking again selects the one already there', () => {
    const { edge } = step();
    store.getState().addCompensation(edge.id);
    const twin = store.getState().document.edges.at(-1)!;
    store.getState().setSelection({ nodes: [], edges: [] });
    store.getState().addCompensation(edge.id);
    expect(store.getState().document.edges).toHaveLength(2);
    expect(store.getState().selection.edges).toEqual([twin.id]);
    // And the undo itself never gets one.
    store.getState().addCompensation(twin.id);
    expect(store.getState().document.edges).toHaveLength(2);
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
