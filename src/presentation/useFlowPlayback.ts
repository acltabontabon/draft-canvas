import { useCallback, useEffect, useMemo } from 'react';
import { getViewportForBounds, useReactFlow, useStore } from '@xyflow/react';
import { findFlow } from '../document/flow';
import type { DraftEdge, DraftFlow } from '../document/types';
import { nodeIndex } from '../store/selectors';
import { useEditorStore } from '../store/editorStore';

export interface FlowPlaybackStep {
  edge: DraftEdge;
  index: number;
  step: number;
  caption?: string;
}

export interface FlowPlaybackController {
  /** Every flow in the document — used to render the picker when none is chosen yet. */
  flows: DraftFlow[];
  flow: DraftFlow | null;
  steps: FlowPlaybackStep[];
  step: number;
  current: FlowPlaybackStep | null;
  active: boolean;
  /** Playback is active but no flow has been chosen yet — show the picker. */
  picking: boolean;
  canStart: boolean;
  start: () => void;
  pickFlow: (flowId: string) => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  goTo: (step: number) => void;
}

/** Never zoom in so far on a single connection that context is lost. */
const MAX_STEP_ZOOM = 1.15;
const STEP_PADDING = 0.4;

/**
 * Presentation Mode: walking someone through a flow, one connection at a time.
 *
 * Reads directly from the selected flow's ordered steps — there is no
 * separate presentation model to keep in step with the document, and a step
 * referencing a since-deleted connector simply drops out of `steps`.
 */
export function useFlowPlayback(): FlowPlaybackController {
  const document = useEditorStore((state) => state.document);
  const flowPlayback = useEditorStore((state) => state.flowPlayback);
  const setFlowPlayback = useEditorStore((state) => state.setFlowPlayback);
  const { setViewport, getViewport } = useReactFlow();
  // Selected separately: returning an object literal from a store selector
  // creates a new identity on every store change and re-renders forever.
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);

  const flow = flowPlayback.flowId ? (findFlow(document, flowPlayback.flowId) ?? null) : null;

  const steps = useMemo<FlowPlaybackStep[]>(() => {
    if (!flow) return [];
    const edgesById = new Map(document.edges.map((e) => [e.id, e]));
    const result: FlowPlaybackStep[] = [];
    flow.steps.forEach((stepEntry, index) => {
      const edge = edgesById.get(stepEntry.edgeId);
      if (!edge) return; // Stale reference — dropped, not crashed on.
      result.push({ edge, index, step: result.length + 1, caption: stepEntry.caption });
    });
    return result;
  }, [document.edges, flow]);

  const current = steps.find((entry) => entry.step === flowPlayback.step) ?? null;

  const focusOn = useCallback(
    (target: FlowPlaybackStep | null) => {
      if (!target) return;
      const nodes = nodeIndex(document.nodes);
      const source = nodes.get(target.edge.source);
      const dest = nodes.get(target.edge.target);
      if (!source || !dest) return;

      const x = Math.min(source.x, dest.x);
      const y = Math.min(source.y, dest.y);
      const bounds = {
        x,
        y,
        width: Math.max(source.x + source.width, dest.x + dest.width) - x,
        height: Math.max(source.y + source.height, dest.y + dest.height) - y,
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
    (target: number) => {
      if (steps.length === 0) return;
      const clamped = Math.max(1, Math.min(steps.length, target));
      setFlowPlayback({ step: clamped });
      focusOn(steps.find((entry) => entry.step === clamped) ?? null);
    },
    [focusOn, setFlowPlayback, steps],
  );

  const pickFlow = useCallback(
    (flowId: string) => {
      const chosen = findFlow(document, flowId);
      if (!chosen || chosen.steps.length === 0) return;
      setFlowPlayback({ active: true, flowId, step: 1 });
      // Canvas step badges follow whichever flow is being presented.
      useEditorStore.getState().setSelectedFlowId(flowId);
      const edgesById = new Map(document.edges.map((e) => [e.id, e]));
      const firstEdge = chosen.steps.map((s) => edgesById.get(s.edgeId)).find(Boolean);
      if (firstEdge) focusOn({ edge: firstEdge, index: 0, step: 1 });
    },
    [document, focusOn, setFlowPlayback],
  );

  const start = useCallback(() => {
    if (document.flows.length === 0) return;
    if (document.flows.length === 1) {
      pickFlow(document.flows[0]!.id);
      return;
    }
    setFlowPlayback({ active: true, flowId: null, step: 0 });
  }, [document.flows, pickFlow, setFlowPlayback]);

  const stop = useCallback(() => setFlowPlayback({ active: false, flowId: null, step: 0 }), [setFlowPlayback]);
  const next = useCallback(() => goTo(flowPlayback.step + 1), [flowPlayback.step, goTo]);
  const previous = useCallback(() => goTo(flowPlayback.step - 1), [flowPlayback.step, goTo]);

  // Deleting the connection you are standing on, or the flow itself, should
  // not strand playback in a broken state.
  useEffect(() => {
    if (!flowPlayback.active || flowPlayback.flowId === null) return; // Picker showing — nothing to reconcile yet.
    if (steps.length === 0) {
      setFlowPlayback({ active: false, flowId: null, step: 0 });
      return;
    }
    if (flowPlayback.step > steps.length) setFlowPlayback({ step: steps.length });
  }, [flowPlayback.active, flowPlayback.flowId, flowPlayback.step, setFlowPlayback, steps.length]);

  return {
    flows: document.flows,
    flow,
    steps,
    step: flowPlayback.step,
    current,
    active: flowPlayback.active,
    picking: flowPlayback.active && flowPlayback.flowId === null,
    canStart: document.flows.length > 0,
    start,
    pickFlow,
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
