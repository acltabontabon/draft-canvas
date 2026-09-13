import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { stepContinuation } from '../src/canvas/stepContinuation';
import { useContinuation } from '../src/canvas/useContinuation';
import { inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode, type CreateNodeInput } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/*
 * Cycling and chaining exercised through the real hook and stores — what `]`, `[`, Tab and Escape
 * do, minus the DOM key plumbing (EditorScreen only adds focus and mode gates on top).
 */

type Spec = Omit<CreateNodeInput, 'x' | 'y'> & { id: string; x?: number; y?: number };

function graph(nodes: Spec[], edges: Array<[string, string]>): DraftDocument {
  const built = nodes.map((spec, i) => createNode({ x: i * 480, y: 0, ...spec }));
  const byId = new Map(built.map((n) => [n.id, n]));
  return addEdges(
    addNodes(createDocument('Cycling'), built),
    edges.map(([source, target]) =>
      createEdge({ source, target, ...inferRelationship(byId.get(source)!, byId.get(target)!), semanticsOrigin: 'inferred' }),
    ),
  );
}

const service = (id: string): Spec => ({ id, type: 'service' });
const topic = (id: string): Spec => ({ id, type: 'queue', queueKind: 'topic' });
const queue = (id: string): Spec => ({ id, type: 'queue', queueKind: 'queue' });
const worker = (id: string): Spec => ({ id, type: 'service', serviceKind: 'worker' });
const at = (spec: Spec, x: number): Spec => ({ ...spec, x });

function open(doc: DraftDocument, selected: string) {
  __resetInteraction();
  __resetClipboardSync();
  useEditorStore.setState({
    document: doc,
    history: { past: [], future: [] },
    selection: { nodes: [selected], edges: [] },
    revision: 0,
  });
  useUiStore.getState().resetContinuation();
  useUiStore.getState().setContinuationsEnabled(true);
  return renderHook(() => useContinuation(true));
}

const showing = () => useUiStore.getState().continuation;
const press = (delta: 1 | -1) =>
  act(() => {
    stepContinuation(useEditorStore.getState(), delta);
  });

beforeEach(() => preferences.clear());

describe('cycling alternatives', () => {
  it('shows the best candidate with every alternative counted, and ] / [ step through them, wrapping', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    expect(showing()!.id).toBe('topic-fan-out-queue');
    const alternatives = showing()!.alternatives!;
    expect(alternatives[0]).toBe('topic-fan-out-queue');
    expect(alternatives.length).toBeGreaterThan(1);

    press(1);
    expect(showing()!.id).toBe(alternatives[1]);
    for (let i = 1; i < alternatives.length; i++) press(1);
    expect(showing()!.id).toBe(alternatives[0]);
    press(-1);
    expect(showing()!.id).toBe(alternatives.at(-1));
  });

  it('only one candidate is ever materialized and previewed at a time', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    press(1);
    expect(showing()!.trigger).toBe('select');
    expect(showing()!.nodes.every((n) => !useEditorStore.getState().document.nodes.some((d) => d.id === n.id))).toBe(true);
  });

  it('Tab accepts the alternative currently showing, not the original best', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    press(1);
    const cycled = showing()!;
    act(() => useEditorStore.getState().acceptContinuation(cycled));
    const doc = useEditorStore.getState().document;
    expect(doc.nodes.some((n) => n.id === cycled.continueFromId)).toBe(true);
    expect(useEditorStore.getState().history.past.at(-1)!.label).toBe(cycled.actionLabel);
    expect(useUiStore.getState().continuationCycle).toBeNull();
  });

  it('keeps the chosen alternative (and its ghost ids) through an unrelated edit elsewhere', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    press(1);
    const before = showing()!;
    act(() => {
      useEditorStore.getState().apply('Far away', (doc) => addNodes(doc, [createNode({ type: 'note', x: 9000, y: 9000 })]));
      useEditorStore.getState().setSelection({ nodes: ['t'], edges: [] });
    });
    expect(showing()!.id).toBe(before.id);
    expect(showing()!.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  it('drops a choice once the anchor’s neighborhood changes, falling back to the quiet suggestion', () => {
    open(graph([service('pub'), topic('t'), queue('q')], [['pub', 't']]), 't');
    press(1);
    expect(useUiStore.getState().continuationCycle).not.toBeNull();
    act(() => {
      useEditorStore.getState().apply('Wire', (doc) =>
        addEdges(doc, [createEdge({ source: 't', target: 'q', ...inferRelationship(doc.nodes[1]!, doc.nodes[2]!) })]),
      );
    });
    expect(useUiStore.getState().continuationCycle).toBeNull();
    // Topic now delivers somewhere: nothing to suggest unprompted.
    expect(showing()).toBeNull();
  });

  it('] with nothing showing asks explicitly: the best candidate, and [ the last one', () => {
    // A Queue that already has a consumer is quiet on selection…
    const doc = graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]);
    open(doc, 'q');
    expect(showing()).toBeNull();
    // …but asking still answers.
    press(1);
    const asked = showing()!;
    expect(asked).not.toBeNull();
    expect(asked.alternatives![0]).toBe(asked.id);
    act(() => useUiStore.getState().setContinuationCycle(null));
    expect(showing()).toBeNull();
    press(-1);
    expect(showing()!.id).toBe(asked.alternatives!.at(-1));
  });

  it('] does nothing without exactly one selected node, or with continuation switched off', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    act(() => useEditorStore.getState().setSelection({ nodes: ['t', 'pub'], edges: [] }));
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(false);
    act(() => {
      useEditorStore.getState().setSelection({ nodes: ['t'], edges: [] });
      useUiStore.getState().setContinuationsEnabled(false);
    });
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(false);
    expect(showing()).toBeNull();
  });

  it('only candidates with somewhere to go are alternatives; ] skips the rest, and does nothing if none fit', () => {
    // A note under everything: no new node fits anywhere, but connecting to the Queue already there does.
    const crowd = createNode({ id: 'crowd', type: 'note', x: -2000, y: -2000, width: 5000, height: 5000 });
    const doc = graph([service('pub'), topic('t'), at(queue('q'), 800)], [['pub', 't']]);
    open({ ...doc, nodes: [crowd, ...doc.nodes] }, 't');
    expect(showing()!.id).toBe('connect-existing:q');
    expect(showing()!.alternatives).toEqual(['connect-existing:q']);

    open({ ...doc, nodes: [crowd, ...doc.nodes.filter((n) => n.id !== 'q')] }, 't');
    expect(showing()).toBeNull();
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(false);
  });

  it('a drag hides the offer but keeps the chosen alternative, and ] waits it out', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    press(1);
    const chosen = showing()!.id;
    act(() => useUiStore.getState().setInteractionActive(true));
    expect(showing()).toBeNull();
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(false);
    act(() => useUiStore.getState().setInteractionActive(false));
    expect(showing()!.id).toBe(chosen);
  });

  it('Escape ends the whole continuation — the choice too — and ] can still ask again', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    press(1);
    act(() => useUiStore.getState().dismissContinuation());
    expect(showing()).toBeNull();
    expect(useUiStore.getState().continuationCycle).toBeNull();
    press(1);
    expect(showing()!.id).toBe('topic-fan-out-queue');
  });
});

describe('chaining', () => {
  it('accepting keeps going while confidence holds, then stops: Topic → Queue → Worker → nothing', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    expect(showing()!.label).toBe('Queue');
    act(() => useEditorStore.getState().acceptContinuation(showing()!));
    expect(showing()!.label).toBe('Worker');
    act(() => useEditorStore.getState().acceptContinuation(showing()!));
    // A Worker with no outbound connection has many plausible next moves — so nothing unprompted.
    expect(showing()).toBeNull();
    expect(useEditorStore.getState().history.past).toHaveLength(2);
  });

  it('Escape mid-chain stops it without touching the diagram', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    act(() => useEditorStore.getState().acceptContinuation(showing()!));
    const revision = useEditorStore.getState().revision;
    act(() => useUiStore.getState().dismissContinuation());
    expect(showing()).toBeNull();
    expect(useEditorStore.getState().revision).toBe(revision);
  });
});
