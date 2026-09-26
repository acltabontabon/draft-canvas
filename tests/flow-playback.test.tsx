import { ReactFlowProvider } from '@xyflow/react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { useFlowPlayback } from '../src/presentation/useFlowPlayback';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { PRESENTATION_AT_REST, useUiStore } from '../src/store/uiStore';

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
    // …opening with its title over the whole path: the story starts on the presenter's first press.
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: true, flowId: refund, step: 0, stage: 'opening' });
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

  it('starts the destination at its own opening, with the phase reset', () => {
    const { checkout, refund } = threeFlows();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(checkout));
    rerender();
    act(() => result.current.next());
    rerender();
    expect(useEditorStore.getState().flowPlayback.step).toBe(1);

    act(() => result.current.nextFlow());
    expect(useEditorStore.getState().flowPlayback).toMatchObject({
      active: true,
      flowId: refund,
      step: 0,
      stage: 'opening',
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

describe('useFlowPlayback — switching to a named variant lands on the shared step', () => {
  beforeEach(reset);

  it('lands on the step sharing a connector when picking a variant, not step 1', () => {
    const edgeA = connectedPair();
    const edgeShared = connectedPair();
    const edgeB = connectedPair();
    useEditorStore.setState((state) => ({
      document: {
        ...state.document,
        flows: [
          { id: 'fnorm', title: 'Payment', steps: [{ id: 's1', edgeId: edgeA.id }, { id: 's2', edgeId: edgeShared.id }] },
          { id: 'ffail', title: 'Payment — failure path', variantOf: 'fnorm', steps: [{ id: 's1', edgeId: edgeShared.id }, { id: 's2', edgeId: edgeB.id }] },
        ],
      },
    }));
    const { result } = mount();
    act(() => result.current.pickFlow('fnorm'));
    // Standing on the shared step of the normal flow...
    act(() => result.current.goTo(2));
    expect(useEditorStore.getState().flowPlayback.step).toBe(2);

    act(() => result.current.pickFlow('ffail'));
    // ...lands on the failure path's corresponding step (index 0, its own step 1), not always step 1
    // by coincidence — the assertion that matters is it's the step carrying the *same* connector.
    const landedStep = useEditorStore.getState().flowPlayback.step;
    const failure = useEditorStore.getState().document.flows.find((f) => f.id === 'ffail')!;
    expect(failure.steps[landedStep - 1]?.edgeId).toBe(edgeShared.id);
  });

  it('always opens afresh when switching between two unrelated flows', () => {
    const edgeA = connectedPair();
    const edgeB = connectedPair();
    useEditorStore.setState((state) => ({
      document: {
        ...state.document,
        flows: [
          { id: 'f1', title: 'One', steps: [{ id: 's1', edgeId: edgeA.id }] },
          { id: 'f2', title: 'Two (unrelated)', steps: [{ id: 's1', edgeId: edgeB.id }, { id: 's2', edgeId: edgeA.id }] },
        ],
      },
    }));
    const { result } = mount();
    act(() => result.current.pickFlow('f1'));
    act(() => result.current.pickFlow('f2'));
    // f2's step 2 also references edgeA (shared with f1's step 1) — but f1/f2 are not variants of
    // one another, so pairing must never kick in here.
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ flowId: 'f2', step: 0, stage: 'opening' });
  });
});

/**
 * The shape of one telling: an opening that frames the whole flow under its title, the steps, and
 * a closing that returns to the whole path — then the next flow's opening, never a wrap. Every
 * transition is the presenter's own press; nothing here runs on a timer.
 */
describe('useFlowPlayback — opening, steps, closing', () => {
  beforeEach(reset);

  function twoStepFlow(title = 'Checkout') {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = state.addNode({ type: 'service', x: 300, y: 0, text: 'B' });
    const c = state.addNode({ type: 'service', x: 600, y: 0, text: 'C' });
    const ab = state.connect(a.id, b.id)!;
    const bc = state.connect(b.id, c.id)!;
    const flow = useEditorStore.getState().createFlow(title)!;
    useEditorStore.getState().addEdgeToFlow(flow, ab.id);
    useEditorStore.getState().addEdgeToFlow(flow, bc.id);
    return flow;
  }

  it('walks opening → step 1 → step 2 → closing, and back the same way', () => {
    const flow = twoStepFlow();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(flow));
    rerender();
    expect(result.current.stage).toBe('opening');
    expect(result.current.current).toBeNull();

    act(() => result.current.next());
    rerender();
    expect(result.current.stage).toBe('step');
    expect(result.current.step).toBe(1);
    expect(result.current.current?.step).toBe(1);

    act(() => result.current.next());
    rerender();
    expect(result.current.step).toBe(2);

    act(() => result.current.next());
    rerender();
    expect(result.current.stage).toBe('closing');
    expect(result.current.atEnd).toBe(true);
    // The closing keeps the last step's number, so "back" lands where the story ended…
    expect(result.current.step).toBe(2);
    expect(result.current.current).toBeNull();

    // …and the end of the last flow is the end: another press changes nothing.
    act(() => result.current.next());
    rerender();
    expect(result.current.stage).toBe('closing');

    act(() => result.current.previous());
    rerender();
    expect(result.current).toMatchObject({ stage: 'step', step: 2 });
    act(() => result.current.previous());
    act(() => result.current.previous());
    rerender();
    expect(result.current).toMatchObject({ stage: 'opening', step: 0 });
    // The opening is where going back stops.
    act(() => result.current.previous());
    rerender();
    expect(result.current.stage).toBe('opening');
  });

  it('closes into the next flow\'s opening, and replays from the closing', () => {
    const first = twoStepFlow('First');
    const second = twoStepFlow('Second');
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(first));
    act(() => result.current.last());
    rerender();
    expect(result.current).toMatchObject({ stage: 'step', step: 2 });
    act(() => result.current.next());
    rerender();
    expect(result.current.stage).toBe('closing');
    expect(result.current.atEnd).toBe(false);

    act(() => result.current.replay());
    rerender();
    expect(result.current).toMatchObject({ stage: 'step', step: 1, flow: expect.objectContaining({ id: first }) });

    act(() => result.current.last());
    act(() => result.current.next());
    act(() => result.current.next());
    rerender();
    expect(result.current).toMatchObject({ stage: 'opening', step: 0, flow: expect.objectContaining({ id: second }) });
  });

  it('jumping to a step leaves any overview stage, and rapid presses converge on the last one', () => {
    const flow = twoStepFlow();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(flow));
    act(() => result.current.goTo(2));
    rerender();
    expect(result.current).toMatchObject({ stage: 'step', step: 2 });
    act(() => {
      result.current.next();
    });
    rerender();
    expect(result.current.stage).toBe('closing');
    act(() => {
      result.current.goTo(1);
      result.current.next();
      result.current.previous();
      result.current.first();
    });
    rerender();
    expect(result.current).toMatchObject({ stage: 'step', step: 1 });
  });

  it('the Overview action keeps the step and marks the camera as pulled back until framing resumes', () => {
    const flow = twoStepFlow();
    const { result, rerender } = mount();
    act(() => result.current.pickFlow(flow));
    act(() => result.current.goTo(2));
    rerender();
    act(() => result.current.overview());
    rerender();
    expect(result.current).toMatchObject({ stage: 'step', step: 2 });
    expect(useUiStore.getState().presentation.framing).toBe('overview');
    // The presenter's own hand on the camera is remembered the same way, until they ask for the frame back.
    act(() => useUiStore.getState().setPresentation({ framing: 'manual' }));
    act(() => result.current.resumeFraming());
    expect(useUiStore.getState().presentation.framing).toBe('guided');
    expect(result.current.step).toBe(2);
  });

  it('stopping puts presentation state back to rest', () => {
    const flow = twoStepFlow();
    const { result } = mount();
    act(() => result.current.pickFlow(flow));
    act(() => useUiStore.getState().setPresentation({ pointer: true, framing: 'manual' }));
    act(() => result.current.stop());
    expect(useUiStore.getState().presentation).toEqual(PRESENTATION_AT_REST);
    expect(useEditorStore.getState().flowPlayback).toMatchObject({ active: false, flowId: null, step: 0 });
  });
});
