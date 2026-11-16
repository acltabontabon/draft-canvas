import { act, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { Profiler, useEffect, type ProfilerOnRenderCallback } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FanInPreview } from '../src/canvas/FanInPreview';
import { RecoveryConnectGhost } from '../src/canvas/RecoveryConnectGhost';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * Drag chrome costs a diagram at rest nothing: the fan-in lines and the recovery arrow watch only
 * whether their gesture is on, and read the shapes — and follow the pointer — for as long as it is.
 * Before, each re-rendered on every geometry write whether or not anyone was using it.
 */

const sources = () => ({
  a: createNode({ id: 'a', type: 'service', x: 0, y: 0, width: 100, height: 60, text: 'A' }),
  b: createNode({ id: 'b', type: 'service', x: 300, y: 0, width: 100, height: 60, text: 'B' }),
});

beforeEach(() => {
  __resetInteraction();
  const { a, b } = sources();
  useEditorStore.getState().setDocument(addNodes(createDocument('Chrome'), [a, b]));
  useUiStore.setState({ fanInSources: null, recoveryConnect: null });
});

function moveFirstShape(dx: number) {
  act(() => {
    useEditorStore.getState().commitPositions(new Map([['a', { x: dx, y: 0 }]]));
  });
}

function Probe({ onRender, children }: { onRender: ProfilerOnRenderCallback; children: React.ReactNode }) {
  return (
    <ReactFlowProvider>
      <Profiler id="chrome" onRender={onRender}>
        {children}
      </Profiler>
    </ReactFlowProvider>
  );
}

describe('the recovery arrow', () => {
  it('renders nothing, and nothing again, while no recovery gesture is on', () => {
    let renders = 0;
    const view = render(
      <Probe onRender={() => (renders += 1)}>
        <RecoveryConnectGhost />
      </Probe>,
    );
    const mounted = renders;
    expect(view.container.querySelector('.dc-recovery-connect-ghost')).toBeNull();
    for (let step = 1; step <= 5; step += 1) moveFirstShape(step * 10);
    expect(renders).toBe(mounted);
  });

  it('draws once a gesture is on, and follows the shapes then', () => {
    const view = render(
      <Probe onRender={() => {}}>
        <RecoveryConnectGhost />
      </Probe>,
    );
    act(() => useUiStore.setState({ recoveryConnect: { parentEdgeId: 'e', sourceNodeId: 'a' } }));
    const path = () => view.container.querySelector('.dc-recovery-connect-path')?.getAttribute('d');
    const before = path();
    expect(before).toBeTruthy();
    moveFirstShape(40);
    expect(path()).not.toBe(before);
    act(() => useUiStore.setState({ recoveryConnect: null }));
    expect(view.container.querySelector('.dc-recovery-connect-ghost')).toBeNull();
  });
});

/** Puts a connection in progress in React Flow's own store, as a drag from a handle does. */
function Connection({ to }: { to: { x: number; y: number } | null }) {
  const api = useStoreApi();
  useEffect(() => {
    api.setState({
      connection: to
        ? ({ inProgress: true, to, isValid: null, from: { x: 0, y: 0 }, fromHandle: null, fromPosition: null, fromNode: null, toHandle: null, toPosition: null, toNode: null } as never)
        : ({ inProgress: false, isValid: null, from: null, fromHandle: null, fromPosition: null, fromNode: null, to: null, toHandle: null, toPosition: null, toNode: null } as never),
      transform: [100, 50, 2],
    });
  }, [api, to]);
  return null;
}

describe('the fan-in lines', () => {
  it('render nothing, and nothing again, while no fan-in is dragged', () => {
    let renders = 0;
    const view = render(
      <Probe onRender={() => (renders += 1)}>
        <FanInPreview />
      </Probe>,
    );
    const mounted = renders;
    expect(view.container.querySelector('svg')).toBeNull();
    for (let step = 1; step <= 5; step += 1) moveFirstShape(step * 10);
    expect(renders).toBe(mounted);
  });

  it('draw a line from each shape to the pointer, in canvas units, through the camera', () => {
    useUiStore.setState({ fanInSources: ['a', 'b'] });
    const view = render(
      <ReactFlowProvider>
        <Connection to={{ x: 700, y: 450 }} />
        <FanInPreview />
      </ReactFlowProvider>,
    );
    const lines = [...view.container.querySelectorAll('line')];
    expect(lines).toHaveLength(2);
    // React Flow keeps the end in pane pixels: (700 − 100) / 2, (450 − 50) / 2.
    expect(lines.map((line) => [line.getAttribute('x2'), line.getAttribute('y2')])).toEqual([['300', '200'], ['300', '200']]);
    expect(lines.map((line) => [line.getAttribute('x1'), line.getAttribute('y1')])).toEqual([['50', '30'], ['350', '30']]);
  });

  it('follow the shapes as they move, and skip one that is gone', () => {
    useUiStore.setState({ fanInSources: ['a', 'gone'] });
    const view = render(
      <ReactFlowProvider>
        <Connection to={{ x: 700, y: 450 }} />
        <FanInPreview />
      </ReactFlowProvider>,
    );
    expect(view.container.querySelectorAll('line')).toHaveLength(1);
    moveFirstShape(100);
    expect(view.container.querySelector('line')?.getAttribute('x1')).toBe('150');
  });
});
