import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { CONTINUATION_DWELL_MS, useContinuation } from '../src/canvas/useContinuation';
import { continuationSets, materialize } from '../src/continuation';
import { inferRelationship } from '../src/document/connectorSemantics';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { __resetClipboardSync, __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * What the continuation hook costs on a large diagram, with the plans the canvas has already built
 * for it. The hook materializes every alternative on each change to the room (it has to know which
 * have somewhere to go), and each materialize reads the document's routed connectors — which are
 * free only because the canvas has routed them for its own drawing (`connectorClearance`). So its
 * cost is the cost of those shared plans staying shared, and a change that quietly breaks that
 * (a plan keyed on something the canvas does not use, say) shows up here as milliseconds per edit
 * turning into tens.
 */

function largeDocument(count: number): { doc: DraftDocument; anchor: string } {
  const columns = Math.ceil(Math.sqrt(count * 1.4));
  const nodes: DraftNode[] = [];
  const kinds = ['service', 'database', 'topic', 'queue', 'worker', 'gateway'] as const;
  for (let i = 0; i < count; i++) {
    const x = (i % columns) * 330;
    const y = Math.floor(i / columns) * 200;
    const id = `n${i}`;
    const kind = kinds[i % kinds.length]!;
    nodes.push(
      kind === 'service' ? createNode({ id, type: 'service', x, y })
      : kind === 'worker' ? createNode({ id, type: 'service', serviceKind: 'worker', x, y })
      : kind === 'gateway' ? createNode({ id, type: 'service', serviceKind: 'gateway', x, y })
      : kind === 'database' ? createNode({ id, type: 'database', x, y })
      : kind === 'topic' ? createNode({ id, type: 'queue', queueKind: 'topic', x, y })
      : createNode({ id, type: 'queue', queueKind: 'queue', x, y }),
    );
  }
  const edges = [];
  for (let i = 0; i < count; i++) {
    for (const j of [i % columns !== columns - 1 ? i + 1 : -1, i + columns < count ? i + columns : -1]) {
      if (j < 0 || j >= count || (i + j) % 3 === 0) continue;
      edges.push(createEdge({ source: nodes[i]!.id, target: nodes[j]!.id, ...inferRelationship(nodes[i]!, nodes[j]!), semanticsOrigin: 'inferred' }));
    }
  }
  // A Topic with a publisher and nowhere to deliver, off to one side: what the quiet suggestion fires on.
  const publisher = createNode({ id: 'publisher', type: 'service', x: -1400, y: 0 });
  const target = createNode({ id: 'target', type: 'queue', queueKind: 'topic', x: -900, y: 0 });
  nodes.push(publisher, target);
  edges.push(createEdge({ source: publisher.id, target: target.id, ...inferRelationship(publisher, target), semanticsOrigin: 'inferred' }));
  return { doc: addEdges(addNodes(createDocument('Large'), nodes), edges), anchor: target.id };
}

beforeEach(() => {
  preferences.clear();
  // Only the timers: the clock the cost is read from stays real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

describe('useContinuation on a large diagram', () => {
  it('re-evaluates in milliseconds at 1000 shapes when the canvas’s plans are already built', () => {
    const { doc, anchor } = largeDocument(1000);
    // The canvas has routed and planned this document before the hook sees it: do the same work once.
    for (const candidate of continuationSets(doc, anchor).explicit) materialize(doc, candidate);

    __resetInteraction();
    __resetClipboardSync();
    useEditorStore.setState({ document: doc, history: { past: [], future: [] }, selection: { nodes: [anchor], edges: [] }, revision: 0 });
    useUiStore.getState().resetContinuation();
    useUiStore.getState().setContinuationsEnabled(true);
    renderHook(() => useContinuation(true));
    act(() => void vi.advanceTimersByTime(CONTINUATION_DWELL_MS));
    expect(useUiStore.getState().continuation, 'the fixture should offer something').not.toBeNull();

    // Each of these re-runs the hook's whole effect against the same, warm document.
    const runs = 20;
    const start = performance.now();
    for (let i = 0; i < runs; i++) act(() => useUiStore.getState().recordContinuationAccepted(i % 2 === 0 ? 'queue-consumer' : 'topic-fan-out-queue'));
    const perRun = (performance.now() - start) / runs;

    // Measured at 0.7 ms a run on a quiet machine; the same runs each against a document the plans
    // have not seen cost about 50 ms. The ceiling sits between them with room for either side to be
    // noisy — shared CI runners are slower than a laptop, so a tight figure would only ever flake — and
    // trips when the plans stop being shared, which is what this is for. (A cold figure is deliberately
    // not asserted: building those plans is the planners' own tests' business, and it varies with the
    // machine far more than a lookup does.)
    expect(perRun).toBeLessThan(10);
  });
});
