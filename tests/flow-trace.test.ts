import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { appendFlowTrace, createFlow } from '../src/document/flow';
import { LIMITS } from '../src/document/limits';
import { serializeDocument } from '../src/export/project';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

beforeEach(() => {
  __resetInteraction();
  useUiStore.setState({ flowTrace: null, readOnly: null });
  useEditorStore.getState().setDocument(createDocument('Trace'));
});

function diagram() {
  const editor = useEditorStore.getState();
  const a = editor.addNode({ type: 'service', x: 0, y: 0 });
  const b = editor.addNode({ type: 'queue', x: 300, y: 0 });
  const c = editor.addNode({ type: 'service', x: 600, y: 0 });
  return [editor.connect(a.id, b.id)!.id, editor.connect(b.id, c.id)!.id];
}

describe('flow tracing', () => {
  it('previews without changing export or history, then commits and undoes atomically', () => {
    const edges = diagram();
    const before = useEditorStore.getState();
    const json = serializeDocument(before.document);
    before.beginFlowTrace();
    before.traceEdge(edges[1]!);
    before.traceEdge(edges[0]!);
    expect(serializeDocument(useEditorStore.getState().document)).toBe(json);
    expect(useEditorStore.getState().history).toBe(before.history);
    expect(before.finishFlowTrace()).toBe(true);
    const committed = useEditorStore.getState();
    expect(committed.document.flows[0]!.steps.map((step) => step.edgeId)).toEqual([...edges].reverse());
    expect(committed.history.past).toHaveLength(before.history.past.length + 1);
    committed.undo();
    expect(useEditorStore.getState().document.flows).toEqual([]);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().document.flows[0]!.steps).toHaveLength(2);
  });

  it('extends a flow, ignores existing and repeated connectors, and cancels without a change', () => {
    const [first, second] = diagram();
    const editor = useEditorStore.getState();
    const id = editor.createFlow('Order')!;
    editor.addEdgeToFlow(id, first!);
    editor.beginFlowTrace(id);
    editor.traceEdge(first!);
    expect(useUiStore.getState().flowTrace?.message).toContain('step 1');
    editor.traceEdge(second!);
    editor.traceEdge(second!);
    expect(useUiStore.getState().flowTrace?.edgeIds).toEqual([second]);
    const before = useEditorStore.getState().document;
    useUiStore.getState().setFlowTrace(null);
    expect(useEditorStore.getState().document).toBe(before);
    editor.beginFlowTrace(id);
    editor.traceEdge(second!);
    editor.finishFlowTrace();
    expect(useEditorStore.getState().document.flows[0]!.steps.map((step) => step.edgeId)).toEqual([first, second]);
  });

  it('cannot commit against a stale revision and clears on a document switch', () => {
    const edges = diagram();
    const editor = useEditorStore.getState();
    editor.beginFlowTrace();
    editor.traceEdge(edges[0]!);
    useEditorStore.setState((state) => ({ revision: state.revision + 1 }));
    expect(editor.finishFlowTrace()).toBe(false);
    editor.setDocument(createDocument('Other'));
    expect(useUiStore.getState().flowTrace).toBeNull();
  });

  it('rejects invalid and overflowing batches without partial edits', () => {
    const [edge] = diagram();
    const document = useEditorStore.getState().document;
    expect(appendFlowTrace(document, createFlow(), [edge!, 'missing'])).toBe(document);
    const full = createFlow();
    full.steps = Array.from({ length: LIMITS.maxStepsPerFlow }, (_, i) => ({ id: String(i), extraNodeIds: [document.nodes[0]!.id] }));
    expect(appendFlowTrace(document, full, [edge!])).toBe(document);
  });
});

it('blocks editing and native undo while a trace is provisional', () => {
  const [edge] = diagram();
  const editor = useEditorStore.getState();
  const before = editor.document;
  editor.beginFlowTrace();
  editor.traceEdge(edge!);
  editor.rename('Should not change');
  editor.undo();
  expect(useEditorStore.getState().document).toBe(before);
  expect(useUiStore.getState().flowTrace?.edgeIds).toEqual([edge]);
});
