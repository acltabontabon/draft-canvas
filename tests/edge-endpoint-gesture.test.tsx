import { fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeEndpointHandle } from '../src/canvas/DraftEdgeView';
import { useUiStore } from '../src/store/uiStore';

/**
 * A connector's endpoint handles exist only while it is selected, so they unmount whenever the
 * selection moves — including the moment a shape drag starts and selects the shape. The gesture
 * fields in `uiStore` are shared by every gesture: a handle gives back what its own drag took, and
 * nothing else.
 */
function mount() {
  const onDrag = vi.fn();
  const view = render(
    <ReactFlowProvider>
      <EdgeEndpointHandle edgeId="e1" endpoint="source" x={10} y={10} pinned={false} oppositeNodeId="b" onDrag={onDrag} />
    </ReactFlowProvider>,
  );
  return { ...view, handle: view.container.querySelector('.dc-edge-endpoint') as HTMLElement };
}

describe('a connector endpoint handle and the shared gesture state', () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState(), true);
    // jsdom has no pointer capture; the handle only needs the calls to exist.
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it('leaves another gesture’s lock alone when it unmounts without having dragged', () => {
    const { unmount } = mount();
    // A shape drag has begun: it holds the lock, and selecting the shape unmounts the handles.
    useUiStore.getState().setInteractionActive(true, ['a']);
    unmount();
    expect(useUiStore.getState().interactionActive).toBe(true);
    expect([...useUiStore.getState().movingNodeIds]).toEqual(['a']);
  });

  it('leaves the lock alone after a press that never became a drag', () => {
    const { handle, unmount } = mount();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    useUiStore.getState().setInteractionActive(true, ['a']);
    unmount();
    expect(useUiStore.getState().interactionActive).toBe(true);
  });

  it('gives back its own lock when it unmounts in the middle of a drag', () => {
    const { handle, unmount } = mount();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 80, clientY: 60 });
    expect(useUiStore.getState().interactionActive).toBe(true);
    expect(useUiStore.getState().reconnectDragActive).toBe(true);
    unmount();
    expect(useUiStore.getState().interactionActive).toBe(false);
    expect(useUiStore.getState().reconnectDragActive).toBe(false);
  });

  it('gives back its lock on Escape, and again does nothing once idle', () => {
    const { handle, unmount } = mount();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().interactionActive).toBe(false);
    useUiStore.getState().setInteractionActive(true, ['a']);
    unmount();
    expect(useUiStore.getState().interactionActive).toBe(true);
  });
});
