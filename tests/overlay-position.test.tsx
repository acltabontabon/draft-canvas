import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOverlayPosition } from '../src/canvas/useOverlayPosition';
import { rightClearance } from '../src/canvas/canvasFrame';

interface FlowState {
  domNode: HTMLDivElement | null;
  transform: [number, number, number];
}

const flow = vi.hoisted(() => ({
  state: { domNode: null as HTMLDivElement | null, transform: [0, 0, 1] as [number, number, number] },
  listeners: new Set<(state: FlowState) => void>(),
}));
vi.mock('@xyflow/react', () => ({
  useStore: (select: (state: typeof flow.state) => unknown) => select(flow.state),
  useStoreApi: () => ({
    getState: () => flow.state,
    subscribe: (listener: (state: typeof flow.state) => void) => {
      flow.listeners.add(listener);
      return () => flow.listeners.delete(listener);
    },
  }),
}));

let observers: Map<Element, ResizeObserverCallback>;
let root: HTMLDivElement;
let panel: HTMLDivElement;
let bounds: DOMRect;
let readBounds: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  observers = new Map();
  vi.stubGlobal('ResizeObserver', class {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe(element: Element) { observers.set(element, this.callback); }
    disconnect() { for (const [element, callback] of observers) if (callback === this.callback) observers.delete(element); }
  });
  root = document.createElement('div');
  panel = document.createElement('div');
  bounds = new DOMRect(40, 60, 800, 600);
  readBounds = vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => bounds);
  Object.defineProperties(panel, { offsetWidth: { value: 100 }, offsetHeight: { value: 50 } });
  flow.state = { domNode: root, transform: [10, 20, 2] };
});

afterEach(() => {
  cleanup();
  flow.listeners.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  return renderHook(({ x, frozen }) => useOverlayPosition({ current: panel }, 'above', (frame) => {
    const screen = frame.flowToScreenPosition({ x, y: 30 });
    const local = frame.screenToOverlay(screen);
    return { placement: 'above', transform: `translate(${local.x}px, ${local.y}px)`, vars: { '--screen-x': String(screen.x) } };
  }, frozen), { initialProps: { x: 20, frozen: false } });
}

function resize(element: Element) {
  observers.get(element)!([], {} as ResizeObserver);
}

describe('canvas overlay positioning', () => {
  it('changes anchors and follows pan/zoom without reading canvas layout again', () => {
    const { rerender } = mount();
    expect(panel.style.transform).toBe('translate(50px, 80px)');
    expect(panel.style.getPropertyValue('--screen-x')).toBe('90');
    const reads = readBounds.mock.calls.length;
    rerender({ x: 80, frozen: false });
    expect(panel.style.transform).toBe('translate(170px, 80px)');
    act(() => {
      flow.state = { ...flow.state, transform: [-30, 5, 0.5] };
      for (const listener of flow.listeners) listener(flow.state);
    });
    expect(panel.style.transform).toBe('translate(10px, 20px)');
    expect(readBounds).toHaveBeenCalledTimes(reads);
  });

  it('refreshes screen coordinates when the canvas resizes or its container scrolls', () => {
    mount();
    bounds = new DOMRect(100, 200, 600, 400);
    act(() => resize(root));
    expect(panel.style.getPropertyValue('--screen-x')).toBe('150');
    expect(panel.style.transform).toBe('translate(50px, 80px)');
    bounds = new DOMRect(120, 210, 600, 400);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(panel.style.getPropertyValue('--screen-x')).toBe('170');
  });

  it('ignores unchanged canvas notifications so placement cannot feed an observer loop', () => {
    const place = vi.fn(() => ({ placement: 'above', transform: 'translate(0px, 0px)' }));
    renderHook(() => useOverlayPosition({ current: panel }, 'above', place));
    const calls = place.mock.calls.length;
    act(() => resize(root));
    expect(place).toHaveBeenCalledTimes(calls);
    bounds = new DOMRect(40, 60, 700, 600);
    act(() => resize(root));
    expect(place).toHaveBeenCalledTimes(calls + 1);
  });

  it('holds a hidden overlay during a gesture and repositions when it becomes visible', () => {
    const { rerender } = mount();
    rerender({ x: 80, frozen: true });
    act(() => {
      flow.state = { ...flow.state, transform: [0, 0, 1] };
      for (const listener of flow.listeners) listener(flow.state);
    });
    expect(panel.style.transform).toBe('translate(50px, 80px)');
    rerender({ x: 80, frozen: false });
    expect(panel.style.transform).toBe('translate(80px, 30px)');
  });

  it('uses observed canvas bounds for docked-panel clearance without another DOM query', () => {
    const query = vi.spyOn(document, 'querySelector');
    expect(rightClearance(false, 12, window.innerWidth - 200)).toBe(212);
    expect(rightClearance(true, 12, window.innerWidth - 200)).toBe(524);
    expect(query).not.toHaveBeenCalled();
  });
});
