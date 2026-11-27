import { act, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMakeRoom } from '../src/canvas/useMakeRoom';
import { createDocument, createNode } from '../src/document/factory';
import { __resetInteraction, isInteracting, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * The Make room tool's one drag is a gesture like any other, so it holds `interactionActive` while it
 * runs. It did not: the keyboard, paste and shape keys are held off by that flag, so a Delete or a
 * shape key mid-drag was applied, and the next pointer move rebuilt the room from where the drag
 * began and threw it away with no undo step. Like every gesture, it gives back only what it took.
 */
function Pane() {
  const pane = useRef<HTMLDivElement>(null);
  useMakeRoom(pane);
  return (
    <div ref={pane}>
      <div className="react-flow__renderer">
        <div data-testid="canvas" />
      </div>
    </div>
  );
}

function mount() {
  const view = render(
    <ReactFlowProvider>
      <Pane />
    </ReactFlowProvider>,
  );
  return { ...view, canvas: view.getByTestId('canvas') };
}

const service = createNode({ id: 'n_far', type: 'service', x: 400, y: 0, text: 'Far' });
const x = () => useEditorStore.getState().document.nodes[0]!.x;

describe('the Make room tool', () => {
  beforeEach(() => {
    __resetInteraction();
    useUiStore.setState(useUiStore.getInitialState(), true);
    // jsdom has no pointer capture; the tool only needs the calls to exist.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => true);
    useEditorStore.setState({
      document: { ...createDocument('Room'), nodes: [service] },
      path: [],
      outer: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      revision: 0,
    });
    useUiStore.getState().setMakeRoom({ line: null });
  });

  it('holds the keyboard off while its drag is under way, and lets go when it ends', () => {
    const { canvas } = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    expect(useUiStore.getState().interactionActive).toBe(false);
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 102 });
    expect(isInteracting()).toBe(true);
    expect(useUiStore.getState().interactionActive).toBe(true);
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 180, clientY: 102 });
    expect(x()).toBe(480);
    expect(useUiStore.getState().interactionActive).toBe(false);
    expect(useEditorStore.getState().history.past.map((entry) => entry.label)).toEqual(['Make room']);
  });

  it('lets go when Escape gives the drag up, or the tool is put down in the middle of it', () => {
    const { canvas } = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 102 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().interactionActive).toBe(false);
    expect(x()).toBe(400);

    act(() => useUiStore.getState().setMakeRoom({ line: null }));
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 160, clientY: 102 });
    expect(useUiStore.getState().interactionActive).toBe(true);
    act(() => useUiStore.getState().setMakeRoom(null));
    expect(useUiStore.getState().interactionActive).toBe(false);
    expect(isInteracting()).toBe(false);
  });

  it('leaves another gesture’s lock alone after a press that never became a drag', () => {
    const { canvas, unmount } = mount();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    useUiStore.getState().setInteractionActive(true, ['n_far']);
    unmount();
    expect(useUiStore.getState().interactionActive).toBe(true);
  });
});
