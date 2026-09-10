import { useCallback, useEffect, useMemo } from 'react';
import { getViewportForBounds, useReactFlow, useStore } from '@xyflow/react';
import { findFlow, flowIsPlayable } from '../document/flow';
import type { DraftEdge, DraftFlowStep, DraftFlow, DraftNode, DraftViewport } from '../document/types';
import { nodeIndex } from '../store/selectors';
import { useEditorStore } from '../store/editorStore';
import { RESPONSE_PHASE_DELAY_MS } from './responsePhase';

export interface FlowPlaybackStep {
  /** The step's primary connector, when it has one — absent for a "frame" step. */
  edge?: DraftEdge;
  /** Every connector this step highlights: the primary one (if any) followed by `extraEdgeIds`. */
  edges: DraftEdge[];
  /** Nodes this step spotlights beyond its edges' own endpoints. */
  extraNodes: DraftNode[];
  index: number;
  step: number;
  caption?: string;
  /** An explicit viewport this step shows verbatim — `focusOn` skips auto-fit when present. */
  viewport?: DraftViewport;
}

/**
 * Resolves one flow step's dangling-safe references into the concrete
 * edges/nodes it lights up. Shared by the `steps` memo and `pickFlow`, which
 * needs to resolve a step before the memo (driven by store state one render
 * behind) has caught up. Exported for unit testing — pure, no React Flow
 * dependency.
 */
export function resolveFlowStep(
  stepEntry: DraftFlowStep,
  index: number,
  step: number,
  edgesById: Map<string, DraftEdge>,
  nodesById: Map<string, DraftNode>,
): FlowPlaybackStep | null {
  const edge = stepEntry.edgeId ? edgesById.get(stepEntry.edgeId) : undefined;
  const extraEdges = (stepEntry.extraEdgeIds ?? [])
    .map((id) => edgesById.get(id))
    .filter((e): e is DraftEdge => Boolean(e));
  const edges = edge ? [edge, ...extraEdges] : extraEdges;
  const extraNodes = (stepEntry.extraNodeIds ?? [])
    .map((id) => nodesById.get(id))
    .filter((n): n is DraftNode => Boolean(n));
  if (edges.length === 0 && extraNodes.length === 0 && !stepEntry.viewport) return null;
  return { edge, edges, extraNodes, index, step, caption: stepEntry.caption, viewport: stepEntry.viewport };
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The bounding box a step's playback focus fits to: the union of its edges'
 * endpoints and its `extraNodes`. `null` when the step lights up no members
 * at all (an explicit-viewport-only step, which `focusOn` handles before
 * ever calling this). Exported for unit testing.
 */
export function stepFocusBounds(target: FlowPlaybackStep, nodesById: Map<string, DraftNode>): Bounds | null {
  const members: DraftNode[] = [...target.extraNodes];
  for (const edge of target.edges) {
    const source = nodesById.get(edge.source);
    const dest = nodesById.get(edge.target);
    if (source) members.push(source);
    if (dest) members.push(dest);
  }
  if (members.length === 0) return null;

  const x = Math.min(...members.map((n) => n.x));
  const y = Math.min(...members.map((n) => n.y));
  return {
    x,
    y,
    width: Math.max(...members.map((n) => n.x + n.width)) - x,
    height: Math.max(...members.map((n) => n.y + n.height)) - y,
  };
}

export interface FlowPlaybackController {
  /** The document's *playable* flows (at least one step that resolves) — what the picker, the
   *  palette's "Present flow…" stage and `start()` choose from. An empty flow is never offered. */
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
 * Resolves the camera viewport a step's playback focus should show: its
 * explicit `viewport` verbatim, or a bounds-fit of its members capped at
 * `MAX_STEP_ZOOM`. `null` when the step has neither (nothing to focus on).
 *
 * Pure — no React Flow instance required — so the headless GIF exporter
 * (`src/export/gif.ts`) computes the exact same camera path Presentation
 * Mode itself would, rather than reimplementing this math.
 */
export function resolveStepViewport(
  target: FlowPlaybackStep,
  nodesById: Map<string, DraftNode>,
  viewWidth: number,
  viewHeight: number,
): DraftViewport | null {
  if (target.viewport) return target.viewport;
  const bounds = stepFocusBounds(target, nodesById);
  if (!bounds) return null;
  return getViewportForBounds(bounds, viewWidth, viewHeight, 0.1, MAX_STEP_ZOOM, STEP_PADDING);
}

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
    const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
    const result: FlowPlaybackStep[] = [];
    flow.steps.forEach((stepEntry, index) => {
      const resolved = resolveFlowStep(stepEntry, index, result.length + 1, edgesById, nodesById);
      if (resolved) result.push(resolved);
    });
    return result;
  }, [document.edges, document.nodes, flow]);

  const current = steps.find((entry) => entry.step === flowPlayback.step) ?? null;

  const focusOn = useCallback(
    (target: FlowPlaybackStep | null) => {
      if (!target) return;

      // An explicit per-step viewport is shown verbatim — no bounds, no fit.
      if (target.viewport) {
        void setViewport(target.viewport, { duration: 380 });
        return;
      }

      const bounds = stepFocusBounds(target, nodeIndex(document.nodes));
      if (!bounds) return;

      // Skip the animation when everything is already comfortably on screen.
      // Without this, stepping through a small diagram produces a constant,
      // faintly nauseating micro-pan.
      if (isComfortablyVisible(bounds, getViewport(), viewWidth, viewHeight)) return;

      // `fitBounds` has no maximum zoom, so a step between two adjacent nodes
      // would fill the screen with them. `resolveStepViewport` computes it
      // directly, which is the only way to cap it.
      const next = resolveStepViewport(target, nodeIndex(document.nodes), viewWidth, viewHeight);
      if (!next) return;
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

  // Only flows that would actually show a step. The picker, the palette's "Present flow…"
  // and `start()` all draw from this — an empty flow is never offered, so "Present" never
  // silently does nothing.
  const playableFlows = useMemo(
    () => document.flows.filter((candidate) => flowIsPlayable(document, candidate)),
    [document],
  );

  const pickFlow = useCallback(
    (flowId: string) => {
      const chosen = findFlow(document, flowId);
      if (!chosen || !flowIsPlayable(document, chosen)) return;
      setFlowPlayback({ active: true, flowId, step: 1 });
      // Canvas step badges follow whichever flow is being presented.
      useEditorStore.getState().setSelectedFlowId(flowId);
      // `steps` lags one render behind the store update above, so the first
      // step is resolved by hand rather than read from it.
      const edgesById = new Map(document.edges.map((e) => [e.id, e]));
      const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
      for (const stepEntry of chosen.steps) {
        const resolved = resolveFlowStep(stepEntry, 0, 1, edgesById, nodesById);
        if (resolved) {
          focusOn(resolved);
          break;
        }
      }
    },
    [document, focusOn, setFlowPlayback],
  );

  const start = useCallback(() => {
    if (playableFlows.length === 0) return;
    // The active flow is what the user has been building and looking at — present that. Only
    // without one (or with an empty one) fall back to the single playable flow, then the picker.
    const active = useEditorStore.getState().selectedFlowId;
    const preferred = playableFlows.find((candidate) => candidate.id === active) ?? (playableFlows.length === 1 ? playableFlows[0] : undefined);
    if (preferred) {
      pickFlow(preferred.id);
      return;
    }
    setFlowPlayback({ active: true, flowId: null, step: 0 });
  }, [playableFlows, pickFlow, setFlowPlayback]);

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

  // A step's own two-phase request/response pulse (see `DraftEdge.hasResponse`, `FlowPlaybackState.phase`).
  // Reset happens here, in exactly one place, keyed only on what actually identifies "a new step to
  // animate" — not scattered across `goTo`/`pickFlow`/the reconciliation effect/the edit-mode reset
  // above, which would need to individually remember to also patch `phase` (`setFlowPlayback`'s
  // shallow merge otherwise lets a stale `'response'` bleed into the next step). `current` is
  // deliberately not a dependency: it's derived from these same three values one render later, and
  // listing it would just double-fire this effect on the render where it catches up.
  useEffect(() => {
    setFlowPlayback({ phase: 'request' });
    if (!current?.edge?.hasResponse) return;
    const timer = window.setTimeout(() => setFlowPlayback({ phase: 'response' }), RESPONSE_PHASE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- current intentionally excluded, see comment above.
  }, [flowPlayback.step, flowPlayback.flowId, flowPlayback.active, setFlowPlayback]);

  return {
    flows: playableFlows,
    flow,
    steps,
    step: flowPlayback.step,
    current,
    active: flowPlayback.active,
    picking: flowPlayback.active && flowPlayback.flowId === null,
    canStart: playableFlows.length > 0,
    start,
    pickFlow,
    stop,
    next,
    previous,
    goTo,
  };
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
