import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { NO_OTHER_SUGGESTIONS, stepContinuation } from '../src/canvas/stepContinuation';
import { CONTINUATION_DWELL_MS, useContinuation } from '../src/canvas/useContinuation';
import { inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode, type CreateNodeInput } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { LIMITS } from '../src/document/limits';
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

/** Lets a selection settle: the quiet suggestion waits `CONTINUATION_DWELL_MS` for it. */
const settle = () => act(() => void vi.advanceTimersByTime(CONTINUATION_DWELL_MS));

/** Opens `doc` with `selected` selected and settled — what the cycling and chaining tests start from. */
function open(doc: DraftDocument, selected: string) {
  const rendered = openUnsettled(doc, selected);
  settle();
  return rendered;
}

function openUnsettled(doc: DraftDocument, selected: string) {
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
  useUiStore.getState().setPencil(null);
  return renderHook(() => useContinuation(true));
}

const showing = () => useUiStore.getState().continuation;
const press = (delta: 1 | -1) =>
  act(() => {
    stepContinuation(useEditorStore.getState(), delta);
  });

beforeEach(() => {
  preferences.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

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

  it('previews only the chosen alternative — the others are ids to step to, never drawn — and writes nothing to the document', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    const revision = useEditorStore.getState().revision;
    press(1);
    const offer = showing()!;
    expect(offer.trigger).toBe('select');
    // The one candidate showing is real nodes and connectors, not yet in the document…
    expect(offer.nodes.length).toBeGreaterThan(0);
    expect(offer.nodes.every((n) => !useEditorStore.getState().document.nodes.some((d) => d.id === n.id))).toBe(true);
    expect(offer.edges.every((e) => !useEditorStore.getState().document.edges.some((d) => d.id === e.id))).toBe(true);
    // …and what it counts as alternatives is a list of ids: nothing else is materialized for the ghost.
    expect(offer.alternatives!.every((id) => typeof id === 'string')).toBe(true);
    expect(useEditorStore.getState().revision).toBe(revision);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
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

  it('stays away while Traffic is showing, like Focus and the flow lens', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    expect(showing()).not.toBeNull();
    act(() => useEditorStore.getState().showTraffic());
    expect(useEditorStore.getState().traffic.active).toBe(true);
    // Before, a ghost drew over the traffic sketches and ] added shapes mid-analysis.
    expect(showing()).toBeNull();
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(false);
    act(() => useEditorStore.setState({ traffic: { ...useEditorStore.getState().traffic, active: false } }));
  });

  it('only candidates with somewhere to go are alternatives; ] skips the rest, and asks back if none fit', () => {
    // A note under everything: no new node fits anywhere, but connecting to the Queue already there does.
    const crowd = createNode({ id: 'crowd', type: 'note', x: -2000, y: -2000, width: 5000, height: 5000 });
    const doc = graph([service('pub'), topic('t'), at(queue('q'), 800)], [['pub', 't']]);
    open({ ...doc, nodes: [crowd, ...doc.nodes] }, 't');
    expect(showing()!.id).toBe('connect-existing:q');
    expect(showing()!.alternatives).toEqual(['connect-existing:q']);

    open({ ...doc, nodes: [crowd, ...doc.nodes.filter((n) => n.id !== 'q')] }, 't');
    expect(showing()).toBeNull();
    // Nowhere to put anything — the picker, not silence. A Topic is no ambiguous shape, so no note.
    expect(stepContinuation(useEditorStore.getState(), 1)).toEqual({ ask: 't', note: undefined });
  });

  it('] on a shape with no suggestion asks back, saying why — never silence', () => {
    const table: Spec = { id: 'tbl', type: 'database', databaseKind: 'table' };
    open(graph([service('s'), table], [['s', 'tbl']]), 'tbl');
    const asked = stepContinuation(useEditorStore.getState(), 1);
    expect(asked).toMatchObject({ ask: 'tbl' });
    expect(asked !== true && asked !== false && asked.note).toMatch(/outbox/i);
    expect(stepContinuation(useEditorStore.getState(), -1)).toMatchObject({ ask: 'tbl' });
    // Asking never conjures a ghost for it.
    expect(showing()).toBeNull();
  });

  it('] still does nothing for a shape continuation never anchors on', () => {
    open(graph([{ id: 'n', type: 'note' }], []), 'n');
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
    // The new Queue is a new selection: its suggestion waits for it to settle, like any other.
    expect(showing()).toBeNull();
    settle();
    expect(showing()!.label).toBe('Worker');
    act(() => useEditorStore.getState().acceptContinuation(showing()!));
    settle();
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

describe('settling', () => {
  const topicDoc = () => graph([service('pub'), topic('t')], [['pub', 't']]);

  it('the quiet suggestion for a new selection waits for it to hold still', () => {
    openUnsettled(topicDoc(), 't');
    expect(showing()).toBeNull();
    act(() => void vi.advanceTimersByTime(CONTINUATION_DWELL_MS - 1));
    expect(showing()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(showing()!.id).toBe('topic-fan-out-queue');
  });

  it('passing through shapes shows none of their suggestions, and the clock restarts on each', () => {
    const doc = graph([service('pub'), topic('t'), queue('q')], [['pub', 't'], ['pub', 'q']]);
    openUnsettled(doc, 't');
    for (const id of ['q', 't', 'q']) {
      act(() => void vi.advanceTimersByTime(CONTINUATION_DWELL_MS - 50));
      act(() => useEditorStore.getState().setSelection({ nodes: [id], edges: [] }));
      expect(showing()).toBeNull();
    }
    settle();
    expect(showing()!.anchorId).toBe('q');
  });

  it('an offer already showing is kept up to date at once: an edit does not make it wait again', () => {
    open(topicDoc(), 't');
    const before = showing()!;
    act(() => {
      useEditorStore.getState().apply('Far away', (doc) => addNodes(doc, [createNode({ type: 'note', x: 9000, y: 9000 })]));
    });
    expect(showing()!.id).toBe(before.id);
    expect(showing()!.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  it('asking with ] is never made to wait', () => {
    openUnsettled(graph([service('s'), queue('q'), worker('w')], [['s', 'q'], ['q', 'w']]), 'q');
    expect(showing()).toBeNull();
    press(1);
    expect(showing()).not.toBeNull();
  });
});

describe('the Pencil', () => {
  it('hides the offer, takes ] away from it, and gives the suggestion back when put down', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    expect(showing()).not.toBeNull();
    act(() => useUiStore.getState().setPencil('pen'));
    expect(showing()).toBeNull();
    // Nothing visible to step through, and nothing for a key to add: `]` is not used either.
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(false);
    act(() => useUiStore.getState().setPencil(null));
    expect(showing()).not.toBeNull();
  });
});

describe('`]` with nothing else to step to', () => {
  const lone = () => graph([service('s'), queue('q')], [['s', 'q']]);

  it('says so instead of swallowing the key, and the line goes away by itself', () => {
    open(lone(), 'q');
    expect(showing()!.alternatives).toHaveLength(1);
    expect(useUiStore.getState().continuationNotice).toBeNull();
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(true);
    expect(useUiStore.getState().continuationNotice).toBe(NO_OTHER_SUGGESTIONS);
    expect(NO_OTHER_SUGGESTIONS).toBe('No other suggestions');
    // The suggestion itself is untouched…
    expect(showing()!.id).toBe('queue-consumer');
    // …and so is `[`.
    expect(stepContinuation(useEditorStore.getState(), -1)).toBe(true);
    act(() => void vi.advanceTimersByTime(3000));
    expect(useUiStore.getState().continuationNotice).toBeNull();
  });

  it('is not said when there is somewhere to go', () => {
    open(graph([service('pub'), topic('t')], [['pub', 't']]), 't');
    press(1);
    expect(useUiStore.getState().continuationNotice).toBeNull();
  });
});

describe('the size of the file', () => {
  const limits = LIMITS as { maxNodes: number };
  let normal: number;
  beforeEach(() => {
    normal = limits.maxNodes;
  });
  afterEach(() => {
    limits.maxNodes = normal;
  });

  it('no suggestion is shown that accepting would only refuse, and ] says why', () => {
    const doc = graph([service('pub'), topic('t')], [['pub', 't']]);
    // Room for the shapes drawn and not one more.
    limits.maxNodes = doc.nodes.length;
    open(doc, 't');
    expect(showing()).toBeNull();

    // `]` is not silent: nothing appears, and a toast says the diagram is as large as it can be.
    useUiStore.setState({ toasts: [] });
    expect(stepContinuation(useEditorStore.getState(), 1)).toBe(true);
    expect(showing()).toBeNull();
    expect(useUiStore.getState().toasts.at(-1)?.message).toMatch(/no room for a suggestion/i);

    // Room for one: the single Queue is offered, but not the two-shape subscriber that needs two.
    limits.maxNodes = doc.nodes.length + 1;
    act(() => void useEditorStore.getState().setSelection({ nodes: ['pub'], edges: [] }));
    act(() => void useEditorStore.getState().setSelection({ nodes: ['t'], edges: [] }));
    settle();
    expect(showing()!.id).toBe('topic-fan-out-queue');
    expect(showing()!.alternatives).not.toContain('topic-subscriber');
  });
});
