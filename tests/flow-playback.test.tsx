import { ReactFlowProvider } from '@xyflow/react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { useFlowPlayback } from '../src/presentation/useFlowPlayback';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * `useFlowPlayback` decides what "Present" means: the active flow when it has something to
 * show, otherwise the one playable flow, otherwise a picker — and an empty flow is never
 * offered anywhere, so Present can't silently do nothing.
 */
function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Playback'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
}

function connectedPair() {
  const state = useEditorStore.getState();
  const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = state.addNode({ type: 'service', x: 300, y: 0, text: 'B' });
  return state.connect(a.id, b.id)!;
}

function mount() {
  return renderHook(() => useFlowPlayback(), {
    wrapper: ({ children }) => <ReactFlowProvider>{children}</ReactFlowProvider>,
  });
}

describe('useFlowPlayback — what Present starts', () => {
  beforeEach(reset);

  it('cannot start, and offers nothing, when every flow is empty', () => {
    useEditorStore.getState().createFlow('Empty');
    const { result } = mount();
    expect(result.current.canStart).toBe(false);
    expect(result.current.flows).toEqual([]);
    act(() => result.current.start());
    expect(useEditorStore.getState().flowPlayback.active).toBe(false);
  });

  it('presents the active flow directly when it has steps', () => {
    const edge = connectedPair();
    const state = useEditorStore.getState();
    const checkout = state.createFlow('Checkout')!;
    const refund = state.createFlow('Refund')!;
    state.addEdgeToFlow(checkout, edge.id);
    state.addEdgeToFlow(refund, edge.id);
    state.setSelectedFlowId(refund);

    const { result } = mount();
    expect(result.current.flows.map((f) => f.id)).toEqual([checkout, refund]);
    act(() => result.current.start());
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: true, flowId: refund, step: 1 });
  });

  it('falls back to the one playable flow, then to the picker', () => {
    const edge = connectedPair();
    const state = useEditorStore.getState();
    const checkout = state.createFlow('Checkout')!;
    state.createFlow('Empty');
    state.addEdgeToFlow(checkout, edge.id);

    const { result, rerender } = mount();
    act(() => result.current.start());
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: true, flowId: checkout });

    act(() => result.current.stop());
    const refund = useEditorStore.getState().createFlow('Refund')!;
    useEditorStore.getState().addEdgeToFlow(refund, edge.id);
    useEditorStore.getState().setSelectedFlowId(null);
    rerender();
    act(() => result.current.start());
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: true, flowId: null, step: 0 });
    expect(result.current.picking).toBe(true);
  });

  it('refuses to pick an empty flow instead of flashing playback on and off', () => {
    const empty = useEditorStore.getState().createFlow('Empty')!;
    const { result } = mount();
    act(() => result.current.pickFlow(empty));
    expect(useEditorStore.getState().flowPlayback.active).toBe(false);
  });
});

/**
 * Moving between flows without leaving the presentation. The destination always starts at its own
 * step 1 — "continue where I left off in this flow" would mean the presenter has to remember where
 * that was, and the audience has no way to tell they walked into the middle of something.
 */
describe('useFlowPlayback — moving between flows', () => {
  beforeEach(reset);

  /** Two playable flows over one connector, plus an empty one that must stay invisible. */
  function threeFlows() {
    const edge = connectedPair();
    const state = useEditorStore.getState();
    const checkout = state.createFlow('Checkout')!;
    const refund = state.createFlow('Refund')!;
    state.createFlow('Not started yet');
    state.addEdgeToFlow(checkout, edge.id);
    state.addEdgeToFlow(refund, edge.id);
    return { checkout, refund, edge };
  }

  it('counts position over the flows it can actually reach, skipping the empty one', () => {
    const { checkout, refund } = threeFlows();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(checkout));
    rerender();
    expect(result.current.flowIndex).toBe(0);
    expect(result.current.flows).toHaveLength(2);

    act(() => result.current.nextFlow());
    rerender();
    expect(result.current.flow?.id).toBe(refund);
    expect(result.current.flowIndex).toBe(1);
  });

  it('starts the destination at its own step 1, with the phase reset', () => {
    const { checkout, refund } = threeFlows();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(checkout));
    rerender();

    act(() => result.current.nextFlow());
    expect(useEditorStore.getState().flowPlayback).toMatchObject({
      active: true,
      flowId: refund,
      step: 1,
      phase: 'request',
    });
    // Step badges follow the flow being presented, not the one it was started from.
    expect(useEditorStore.getState().selectedFlowId).toBe(refund);
  });

  it('never wraps: the last flow has no next and the first has no previous', () => {
    const { checkout, refund } = threeFlows();
    const { result, rerender } = mount();

    act(() => result.current.pickFlow(checkout));
    rerender();
    act(() => result.current.previousFlow());
    rerender();
    expect(result.current.flow?.id).toBe(checkout);

    act(() => result.current.pickFlow(refund));
    rerender();
    act(() => result.current.nextFlow());
    rerender();
    expect(result.current.flow?.id).toBe(refund);
  });

  it('does nothing from the picker, where there is no flow to move from', () => {
    threeFlows();
    const { result, rerender } = mount();
    act(() => result.current.start());
    rerender();
    expect(result.current.picking).toBe(true);

    act(() => result.current.nextFlow());
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: true, flowId: null });
  });

  it('falls back to the picker, not out of the presentation, when the flow being shown empties', () => {
    const { checkout } = threeFlows();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(checkout));
    rerender();

    // The story being told loses its last step. The other one is still worth telling, so the
    // presenter lands on the picker rather than back in the editor mid-sentence.
    const stepId = useEditorStore.getState().document.flows.find((f) => f.id === checkout)!.steps[0]!.id;
    act(() => useEditorStore.getState().removeFlowStep(checkout, stepId));
    rerender();
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: true, flowId: null, step: 0 });
    expect(result.current.picking).toBe(true);
  });

  it('ends the presentation outright when nothing is left to present', () => {
    const edge = connectedPair();
    const only = useEditorStore.getState().createFlow('Only one')!;
    useEditorStore.getState().addEdgeToFlow(only, edge.id);
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(only));
    rerender();

    const stepId = useEditorStore.getState().document.flows[0]!.steps[0]!.id;
    act(() => useEditorStore.getState().removeFlowStep(only, stepId));
    rerender();
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: false, flowId: null, step: 0 });
  });

  it('walks four flows without touching the document, its history or its revision', () => {
    const { checkout } = threeFlows();
    const before = useEditorStore.getState();
    const document = before.document;
    const revision = before.revision;
    const past = before.history.past.length;

    const { result, rerender } = mount();
    act(() => result.current.pickFlow(checkout));
    rerender();
    act(() => result.current.next());
    act(() => result.current.nextFlow());
    rerender();
    act(() => result.current.previousFlow());
    rerender();
    act(() => result.current.stop());

    const after = useEditorStore.getState();
    // Identity, not equality: presenting must not even rebuild the document, or autosave would
    // write a new version of a file nobody edited.
    expect(after.document).toBe(document);
    expect(after.revision).toBe(revision);
    expect(after.history.past).toHaveLength(past);
    expect(after.history.future).toHaveLength(0);
  });

  it('tells two flows with the same name apart, because it moves by id and not by title', () => {
    // Nothing stops a diagram having two "Checkout"s, and the bar shows the title — so the
    // position beside it is what makes them distinguishable, and the id is what makes them
    // reachable.
    const edge = connectedPair();
    const state = useEditorStore.getState();
    const first = state.createFlow('Checkout')!;
    const second = state.createFlow('Checkout')!;
    state.addEdgeToFlow(first, edge.id);
    state.addEdgeToFlow(second, edge.id);

    const { result, rerender } = mount();
    act(() => result.current.pickFlow(first));
    rerender();
    expect(result.current.flowIndex).toBe(0);

    act(() => result.current.nextFlow());
    rerender();
    expect(result.current.flow?.id).toBe(second);
    expect(result.current.flowIndex).toBe(1);
    expect(result.current.flows.map((f) => f.title)).toEqual(['Checkout', 'Checkout']);
  });
});
