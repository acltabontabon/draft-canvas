import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type ReactFlowState } from '@xyflow/react';

/**
 * A portal into React Flow's edge-label layer, for a connector's labels, chips and attachment rows.
 *
 * It exists because React Flow's own `<EdgeLabelRenderer>` finds that layer with
 * `domNode.querySelector(...)` inside a store selector — *per instance*, and every connector has
 * one. A store selector runs on every store update, so with 800 connectors each frame of a pan, each
 * click and each drag frame ran 800 DOM queries: on a large diagram that was three quarters of all
 * main-thread time, and the difference between a smooth pan and 15 frames a second.
 *
 * The layer is created once, with the canvas, and never replaced. So it is looked up once — by the
 * one subscriber in `EdgeLabelRoot`, which wraps the canvas — and handed down through context.
 */
const EdgeLabelRootContext = createContext<HTMLElement | null>(null);

/** Per canvas element, once found. A missing layer is not cached: it may simply not have mounted yet. */
const found = new WeakMap<HTMLElement, HTMLElement>();

function selectLabelRoot(state: ReactFlowState): HTMLElement | null {
  const dom = state.domNode;
  if (!dom) return null;
  const known = found.get(dom);
  if (known) return known;
  const layer = dom.querySelector<HTMLElement>('.react-flow__edgelabel-renderer');
  if (layer) found.set(dom, layer);
  return layer;
}

/** Wrap the `<ReactFlow>` element in this, once. It is the only subscriber that looks the layer up. */
export function EdgeLabelRoot({ children }: { children: ReactNode }) {
  const layer = useStore(selectLabelRoot);
  return <EdgeLabelRootContext.Provider value={layer}>{children}</EdgeLabelRootContext.Provider>;
}

/** Renders `children` into the edge-label layer, or nothing until that layer exists. */
export function EdgeLabels({ children }: { children: ReactNode }) {
  const layer = useContext(EdgeLabelRootContext);
  return layer ? createPortal(children, layer) : null;
}
