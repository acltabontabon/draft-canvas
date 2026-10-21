import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type ReactFlowState } from '@xyflow/react';

/**
 * A portal into React Flow's viewport layer, for canvas chrome that pans and zooms with the diagram
 * (guides, the room frame, ghosts, agent previews).
 *
 * React Flow's own `<ViewportPortal>` finds that layer with `domNode.querySelector(...)` inside its
 * store selector, the same trap `EdgeLabels.tsx` records. There is only one instance here, but the
 * layer is the *last* child of the viewport, so each query walked every shape, handle and connector
 * before reaching it — on every store update: each pan frame, drag frame and click, 0.2–0.4 ms apiece
 * at 500 shapes. The layer is created once with the canvas, so it is looked up once.
 */
const found = new WeakMap<HTMLElement, HTMLElement>();

function selectViewportLayer(state: ReactFlowState): HTMLElement | null {
  const dom = state.domNode;
  if (!dom) return null;
  const known = found.get(dom);
  if (known) return known;
  // A missing layer is not cached: it may simply not have mounted yet.
  const layer = dom.querySelector<HTMLElement>('.react-flow__viewport-portal');
  if (layer) found.set(dom, layer);
  return layer;
}

export function ViewportLayer({ children }: { children: ReactNode }) {
  const layer = useStore(selectViewportLayer);
  return layer ? createPortal(children, layer) : null;
}
