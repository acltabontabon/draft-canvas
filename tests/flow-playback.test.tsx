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
