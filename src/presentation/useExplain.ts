import { useCallback, useEffect, useMemo } from 'react';
import { getViewportForBounds, useReactFlow, useStore } from '@xyflow/react';
import { sequenceSteps, type SequenceStep } from '../document/sequence';
import { nodeIndex } from '../store/selectors';
import { useEditorStore } from '../store/editorStore';

export interface ExplainController {
  steps: SequenceStep[];
  step: number;
  current: SequenceStep | null;
  active: boolean;
  canStart: boolean;
  start: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  goTo: (step: number) => void;
}

/** Never zoom in so far on a single connection that context is lost. */
const MAX_STEP_ZOOM = 1.15;
const STEP_PADDING = 0.4;

/**
 * Explain Mode: walking someone through a flow, one connection at a time.
 *
 * It is built directly on the sequence numbers already in the document, so
 * there is no separate presentation model to keep in step — numbering a
 * connection is all it takes to add it to the walkthrough.
 */
export function useExplain(): ExplainController {
  const document = useEditorStore((state) => state.document);
  const explain = useEditorStore((state) => state.explain);
  const setExplain = useEditorStore((state) => state.setExplain);
  const { setViewport, getViewport } = useReactFlow();
  // Selected separately: returning an object literal from a store selector
  // creates a new identity on every store change and re-renders forever.
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);

  const steps = useMemo(() => sequenceSteps(document), [document]);
  const current = steps.find((entry) => entry.sequence === explain.step) ?? null;

  const focusOn = useCallback(
    (step: SequenceStep | null) => {
      if (!step) return;
      const nodes = nodeIndex(document.nodes);
      const source = nodes.get(step.edge.source);
      const target = nodes.get(step.edge.target);
      if (!source || !target) return;

      const x = Math.min(source.x, target.x);
      const y = Math.min(source.y, target.y);
      const bounds = {
        x,
        y,
        width: Math.max(source.x + source.width, target.x + target.width) - x,
        height: Math.max(source.y + source.height, target.y + target.height) - y,
      };

      // Skip the animation when both ends are already comfortably on screen.
      // Without this, stepping through a small diagram produces a constant,
      // faintly nauseating micro-pan.
      if (isComfortablyVisible(bounds, getViewport(), viewWidth, viewHeight)) return;

      // `fitBounds` has no maximum zoom, so a step between two adjacent nodes
      // would fill the screen with them. Computing the viewport directly is the
      // only way to cap it.
      const next = getViewportForBounds(
        bounds,
        viewWidth,
        viewHeight,
        0.1,
        MAX_STEP_ZOOM,
        STEP_PADDING,
      );
      void setViewport(next, { duration: 380 });
    },
    [document.nodes, getViewport, setViewport, viewHeight, viewWidth],
  );

  const goTo = useCallback(
    (step: number) => {
      if (steps.length === 0) return;
      const clamped = Math.max(1, Math.min(steps.length, step));
      setExplain({ step: clamped });
      focusOn(steps.find((entry) => entry.sequence === clamped) ?? null);
    },
    [focusOn, setExplain, steps],
  );

  const start = useCallback(() => {
    if (steps.length === 0) return;
    setExplain({ active: true, step: 1 });
    focusOn(steps[0] ?? null);
  }, [focusOn, setExplain, steps]);

  const stop = useCallback(() => setExplain({ active: false }), [setExplain]);
  const next = useCallback(() => goTo(explain.step + 1), [explain.step, goTo]);
  const previous = useCallback(() => goTo(explain.step - 1), [explain.step, goTo]);

  // Deleting the connection you are standing on should not strand the walkthrough.
  useEffect(() => {
    if (!explain.active) return;
    if (steps.length === 0) {
      setExplain({ active: false, step: 0 });
      return;
    }
    if (explain.step > steps.length) setExplain({ step: steps.length });
  }, [explain.active, explain.step, setExplain, steps.length]);

  return {
    steps,
    step: explain.step,
    current,
    active: explain.active,
    canStart: steps.length > 0,
    start,
    stop,
    next,
    previous,
    goTo,
  };
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isComfortablyVisible(
  bounds: Bounds,
  viewport: { x: number; y: number; zoom: number },
  viewWidth: number,
  viewHeight: number,
): boolean {
  if (viewWidth === 0 || viewHeight === 0) return false;
  const left = bounds.x * viewport.zoom + viewport.x;
  const top = bounds.y * viewport.zoom + viewport.y;
  const right = left + bounds.width * viewport.zoom;
  const bottom = top + bounds.height * viewport.zoom;

  const margin = 72;
  return (
    left > margin && top > margin && right < viewWidth - margin && bottom < viewHeight - margin
  );
}
