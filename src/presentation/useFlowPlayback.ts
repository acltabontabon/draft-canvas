import { useCallback, useEffect, useMemo, useRef } from 'react';
import { getViewportForBounds, useReactFlow, useStore, useStoreApi } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { findFlow, flowIsPlayable } from '../document/flow';
import { boundsOf, type Bounds } from '../document/operations';
import type { DraftEdge, DraftFlowStep, DraftFlow, DraftNode, DraftViewport } from '../document/types';
import { flattenPath } from '../edges/routing';
import { clamp } from '../lib/math';
import { nodeIndex } from '../store/selectors';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { flowOverviewBounds, stepComposition } from './composition';
import { captionCornerFor, composeStep, frameOverview, frameStep, screenRectOf, type Insets } from './framing';
import { RESPONSE_PHASE_DELAY_MS } from './responsePhase';
import { motionMs } from '../lib/motion';

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

/**
 * A flow's playable steps, numbered 1..n after dangling steps drop out — what `flowPlayback.step`
 * indexes into. Shared by the hook and Presentation Mode's callout layer, which must agree on it.
 */
export function resolveFlowSteps(
  flow: DraftFlow,
  edges: readonly DraftEdge[],
  nodes: readonly DraftNode[],
): FlowPlaybackStep[] {
  const edgesById = new Map(edges.map((e) => [e.id, e]));
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const result: FlowPlaybackStep[] = [];
  flow.steps.forEach((stepEntry, index) => {
    const resolved = resolveFlowStep(stepEntry, index, result.length + 1, edgesById, nodesById);
    if (resolved) result.push(resolved);
  });
  return result;
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
  return boundsOf(members);
}

/** Where the presentation is in its telling of a flow — see `FlowPlaybackState.stage`. */
export type PlaybackStage = 'opening' | 'step' | 'closing';

export interface FlowPlaybackController {
  /** The document's *playable* flows (at least one step that resolves) — what the picker, the
   *  palette's "Present flow…" stage and `start()` choose from. An empty flow is never offered. */
  flows: DraftFlow[];
  flow: DraftFlow | null;
  /** 0-based position of `flow` within `flows` — what "Flow 2 of 5" counts — or `-1` for none.
   *  Deliberately an index into the *playable* list: that is the set `nextFlow` can reach, so a
   *  denominator drawn from anywhere else would promise a move that doesn't happen. */
  flowIndex: number;
  steps: FlowPlaybackStep[];
  step: number;
  /** The step being shown — `null` in the opening and closing overviews, where no single step is. */
  current: FlowPlaybackStep | null;
  active: boolean;
  /** Playback is active but no flow has been chosen yet — show the picker. */
  picking: boolean;
  /** The opening (title and overview, before step 1), a step, or the closing overview after the last. */
  stage: PlaybackStage;
  /** The closing of the last flow: nothing follows, and the strip says so. */
  atEnd: boolean;
  canStart: boolean;
  start: () => void;
  pickFlow: (flowId: string) => void;
  stop: () => void;
  /** Forward through the story: opening → step 1 … last step → closing → the next flow's opening. */
  next: () => void;
  /** Back through it: closing → last step … step 1 → opening. The opening is where it stops. */
  previous: () => void;
  goTo: (step: number) => void;
  first: () => void;
  last: () => void;
  /** Back to step 1 from wherever the story is — the closing's "again". */
  replay: () => void;
  /** Pull the camera back to the whole flow, keeping the step. `resumeFraming` returns to it. */
  overview: () => void;
  /** Hand the camera back to the flow after a manual pan or zoom, or an overview. */
  resumeFraming: () => void;
  /** The next/previous flow in document order, started at its own opening. Never wraps: running
   *  off the end of the last flow is the end of the walkthrough, and silently looping back to the
   *  beginning mid-sentence is the one thing a presenter can't recover from gracefully. */
  nextFlow: () => void;
  previousFlow: () => void;
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
 * (`src/export/gif.ts`) computes the same simple camera path for a step it
 * always did, rather than reimplementing this math. The live presentation's
 * directed camera (`framing.ts`) starts from the same box and adds what only
 * a live view has: where the camera already is, and the room the chrome takes.
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
 * The room presentation chrome takes from the view, in screen pixels — the exit control above,
 * the control strip and a caption row below, a margin either side — so a framed interaction never
 * lands under any of it. `PresentationCallout` keeps off the same chrome by measuring it; the
 * camera is decided before that chrome has necessarily laid out, so it reserves the room up front.
 */
export const PRESENTATION_INSETS: Insets = { top: 64, right: 40, bottom: 128, left: 40 };
/** The step caption's footprint the corner choice keeps clear (`.dc-present-caption`). */
export const CAPTION_SIZE = { width: 360, height: 132 };
/** The opening and closing card's footprint (`.dc-present-card`): its column, or its row. */
const CARD_COLUMN = 500;
const CARD_ROW = 200;
/** Wide enough for the card to take a column beside the diagram, like a plate's caption; narrower
 *  views give it a row underneath instead. */
const CARD_COLUMN_MIN_VIEW = 1100;

/** The room an overview leaves for its card — it sits bottom-left, so the diagram is composed to
 *  its right on a wide view and above it on a narrow one, never underneath it. */
export function overviewInsets(view: { width: number; height: number }): Insets {
  return view.width >= CARD_COLUMN_MIN_VIEW
    ? { ...PRESENTATION_INSETS, left: CARD_COLUMN }
    : { ...PRESENTATION_INSETS, bottom: PRESENTATION_INSETS.bottom + CARD_ROW };
}

/** How long each camera move takes — a slide is quicker than a cut, and an overview settles slowest. */
const NUDGE_MS = 320;
const CUT_MS = 440;
const OVERVIEW_MS = 520;
const RESIZE_MS = 240;

/**
 * Presentation Mode: walking someone through a flow, one connection at a time.
 *
 * Reads directly from the selected flow's ordered steps — there is no
 * separate presentation model to keep in step with the document, and a step
 * referencing a since-deleted connector simply drops out of `steps`.
 *
 * A flow is told in three kinds of moment (`stage`): the opening frames the whole flow under its
 * title, each step frames one interaction, and the closing returns to the whole path. The camera
 * is directed rather than centred (`framing.ts`): it holds still when the next interaction already
 * reads, slides when it has to, and cuts only when it must — and it never fights a presenter who
 * has taken the camera by hand (`uiStore.presentation.framing`).
 */
export function useFlowPlayback(): FlowPlaybackController {
  const flowPlayback = useEditorStore((state) => state.flowPlayback);
  const setFlowPlayback = useEditorStore((state) => state.setFlowPlayback);
  // Only what render needs, never the whole document: this hook lives in `EditorScreen`, and a
  // whole-document subscription re-rendered the entire editor on every commit. Edges and nodes are
  // only watched while a flow is actually being presented; everything else reads `getState()`.
  const flow = useEditorStore((state) =>
    flowPlayback.flowId ? (findFlow(state.document, flowPlayback.flowId) ?? null) : null,
  );
  const edges = useEditorStore((state) => (flow ? state.document.edges : NO_EDGES));
  const nodes = useEditorStore((state) => (flow ? state.document.nodes : NO_NODES));
  // Only flows that would actually show a step. The picker, the palette's "Present flow…"
  // and `start()` all draw from this — an empty flow is never offered, so "Present" never
  // silently does nothing. Compared element-wise, so it keeps its identity until a flow's
  // playability (or the flow itself) actually changes.
  const playableFlows = useEditorStore(
    useShallow((state) => state.document.flows.filter((candidate) => flowIsPlayable(state.document, candidate))),
  );
  const { setViewport, getViewport } = useReactFlow();
  const storeApi = useStoreApi();
  // Selected separately: returning an object literal from a store selector
  // creates a new identity on every store change and re-renders forever.
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);

  const steps = useMemo(() => (flow ? resolveFlowSteps(flow, edges, nodes) : []), [edges, nodes, flow]);

  const stage: PlaybackStage = flowPlayback.stage ?? 'step';
  const current = stage === 'step' ? (steps.find((entry) => entry.step === flowPlayback.step) ?? null) : null;

  /**
   * The camera the presentation last asked for, and until when it is still on its way there.
   * React Flow reports the camera mid-flight, so a fast burst of moves judged against the live
   * camera would see one only halfway to the previous frame and skip a reframe it needed. Judging
   * against the intended camera while a move is in flight is what makes rapid stepping converge
   * on the right frame — and a presenter's own gesture (`framing: 'manual'`) always reads the live
   * camera, because by then the intended one is nobody's.
   */
  const intended = useRef<{ camera: DraftViewport; until: number } | null>(null);
  const cameraNow = useCallback((): DraftViewport => {
    const pending = intended.current;
    if (pending && useUiStore.getState().presentation.framing !== 'manual' && performance.now() < pending.until) {
      return pending.camera;
    }
    return getViewport();
  }, [getViewport]);
  const moveTo = useCallback(
    (camera: DraftViewport, ms: number, framing: 'guided' | 'overview' = 'guided') => {
      const duration = motionMs(ms);
      intended.current = { camera, until: performance.now() + duration + 40 };
      useUiStore.getState().setPresentation({ framing });
      void setViewport(camera, { duration });
    },
    [setViewport],
  );

  /**
   * The box each of a step's connectors is actually drawn in, read from the canvas — a bent or
   * bundled route swings outside its endpoints, and the frame must include the bend. Read once per
   * transition, never per frame; absent (no canvas yet, a headless caller) the endpoints suffice.
   */
  const routeBoxesFor = useCallback(
    (target: FlowPlaybackStep): Map<string, Bounds> | undefined => {
      const root = storeApi.getState().domNode;
      if (!root || typeof CSS === 'undefined') return undefined;
      const boxes = new Map<string, Bounds>();
      for (const edge of target.edges) {
        const path = root.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(edge.id)}"] .dc-edge-hit`);
        const box = path ? boundsOf(flattenPath(path.getAttribute('d') ?? '').map((v) => ({ x: v.x, y: v.y, width: 0, height: 0 }))) : null;
        if (box) boxes.set(edge.id, box);
      }
      return boxes.size > 0 ? boxes : undefined;
    },
    [storeApi],
  );

  /**
   * Frame one step: hold, slide or cut (`frameStep`), and seat the caption clear of it.
   *
   * `settle` is the move out of an overview: the opening composed the flow beside its title card,
   * and as the card leaves, the whole picture slides to the centre of the view when the step still
   * reads there — one calm move that says "now we are in it", instead of leaving the diagram
   * parked in a column with the card gone. A step that needs its own frame gets it as usual.
   */
  const frameStepFor = useCallback(
    (target: FlowPlaybackStep, { resize = false, settle = false, fresh = false } = {}) => {
      const ui = useUiStore.getState();
      // An explicit per-step viewport is shown verbatim — no bounds, no fit.
      if (target.viewport) {
        moveTo(target.viewport, resize ? RESIZE_MS : CUT_MS);
        ui.setPresentation({ focus: null, captionCorner: 'bottom-left' });
        return;
      }
      const { document } = useEditorStore.getState();
      const composed = stepComposition(target, nodeIndex(document.nodes), routeBoxesFor(target));
      if (!composed) return;
      const view = { width: viewWidth, height: viewHeight };
      let frame = frameStep(composed.bounds, cameraNow(), view, PRESENTATION_INSETS);
      // Re-centre promised a frame, not a verdict: compose the step afresh even if the camera the
      // presenter left would have done.
      if (fresh && view.width > 0 && view.height > 0) frame = { camera: composeStep(composed.bounds, view, PRESENTATION_INSETS), kind: 'fit' };
      if (settle && flow && view.width > 0 && view.height > 0) {
        const whole = flowOverviewBounds(document.nodes, document.edges, flow);
        const centred = whole ? frameOverview(whole, view, PRESENTATION_INSETS) : null;
        if (centred && frameStep(composed.bounds, centred, view, PRESENTATION_INSETS).kind === 'stay') {
          frame = { camera: centred, kind: 'fit' };
        }
      }
      if (frame.kind !== 'stay') moveTo(frame.camera, resize ? RESIZE_MS : frame.kind === 'nudge' ? NUDGE_MS : CUT_MS);
      else if (ui.presentation.framing === 'overview') ui.setPresentation({ framing: 'guided' });
      ui.setPresentation({
        focus: composed.bounds,
        captionCorner: captionCornerFor(screenRectOf(composed.bounds, frame.camera), view, PRESENTATION_INSETS, CAPTION_SIZE),
      });
    },
    [cameraNow, flow, moveTo, routeBoxesFor, viewHeight, viewWidth],
  );

  /** Frame the whole flow, for the opening, the closing and the Overview action. */
  const frameFlow = useCallback(
    (target: DraftFlow, framing: 'guided' | 'overview', ms = OVERVIEW_MS) => {
      const { document } = useEditorStore.getState();
      const bounds = flowOverviewBounds(document.nodes, document.edges, target);
      const ui = useUiStore.getState();
      if (!bounds || viewWidth === 0 || viewHeight === 0) {
        ui.setPresentation({ focus: bounds, framing });
        return;
      }
      const view = { width: viewWidth, height: viewHeight };
      // The Overview action (a step kept) shows no card, so the whole safe area is the picture.
      moveTo(frameOverview(bounds, view, framing === 'overview' ? PRESENTATION_INSETS : overviewInsets(view)), ms, framing);
      ui.setPresentation({ focus: bounds, captionCorner: 'bottom-left' });
    },
    [moveTo, viewHeight, viewWidth],
  );

  const goTo = useCallback(
    (target: number) => {
      if (steps.length === 0) return;
      const clamped = clamp(target, 1, steps.length);
      const settle = useEditorStore.getState().flowPlayback.stage !== undefined;
      setFlowPlayback({ step: clamped, stage: undefined });
      const landed = steps.find((entry) => entry.step === clamped);
      if (landed) frameStepFor(landed, { settle });
    },
    [frameStepFor, setFlowPlayback, steps],
  );

  const pickFlow = useCallback(
    (flowId: string) => {
      const { document } = useEditorStore.getState();
      const chosen = findFlow(document, flowId);
      if (!chosen || !flowIsPlayable(document, chosen)) return;
      // Switching to or from a named variant (e.g. a failure path) lands on the step sharing the
      // connector being left, rather than always resetting to the first step — matched by the two
      // flows actually sharing a connector, never by index: nothing says step 3 of one flow is the
      // same moment as step 3 of another. Any other switch (including between two unrelated flows)
      // opens the destination: its title over the whole path, with the story a keypress away.
      const isVariantSwitch = flow !== null && (chosen.variantOf === flow.id || flow.variantOf === chosen.id);
      const leavingEdgeId = current?.edge?.id;
      const matchedIndex = isVariantSwitch && leavingEdgeId ? chosen.steps.findIndex((s) => s.edgeId === leavingEdgeId) : -1;
      // Canvas step badges follow whichever flow is being presented.
      useEditorStore.getState().setSelectedFlowId(flowId);
      if (matchedIndex < 0) {
        setFlowPlayback({ active: true, flowId, step: 0, stage: 'opening' });
        frameFlow(chosen, 'guided');
        return;
      }
      // `steps` lags one render behind the store update, so the matched step is resolved by hand
      // — as the step number it will have once dangling steps ahead of it have dropped out.
      const edgesById = new Map(document.edges.map((e) => [e.id, e]));
      const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
      let position = 0;
      let landed: FlowPlaybackStep | null = null;
      for (const [index, stepEntry] of chosen.steps.entries()) {
        const resolved = resolveFlowStep(stepEntry, index, position + 1, edgesById, nodesById);
        if (!resolved) continue;
        position += 1;
        if (index === matchedIndex) {
          landed = resolved;
          break;
        }
      }
      if (!landed) {
        setFlowPlayback({ active: true, flowId, step: 0, stage: 'opening' });
        frameFlow(chosen, 'guided');
        return;
      }
      setFlowPlayback({ active: true, flowId, step: landed.step, stage: undefined });
      frameStepFor(landed);
    },
    [current, flow, frameFlow, frameStepFor, setFlowPlayback],
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
    setFlowPlayback({ active: true, flowId: null, step: 0, stage: undefined });
  }, [playableFlows, pickFlow, setFlowPlayback]);

  const stop = useCallback(() => {
    intended.current = null;
    useUiStore.getState().resetPresentation();
    setFlowPlayback({ active: false, flowId: null, step: 0, stage: undefined });
  }, [setFlowPlayback]);

  const flowIndex = flow ? playableFlows.findIndex((candidate) => candidate.id === flow.id) : -1;
  const upcoming = flowIndex >= 0 ? playableFlows[flowIndex + 1] : undefined;

  // Moving between flows is `pickFlow` and nothing else: the destination opens with its own
  // framing, which is also what resets the request/response phase and lets go of any reveal the
  // presenter left open on the flow being left behind.
  const goToFlow = useCallback(
    (delta: -1 | 1) => {
      // In the picker there is no "current" flow to move from, and the whole list is already on
      // screen — stepping off it sideways would just pick one at random.
      if (flowIndex === -1) return;
      const destination = playableFlows[flowIndex + delta];
      if (!destination) return;
      pickFlow(destination.id);
    },
    [flowIndex, playableFlows, pickFlow],
  );
  const nextFlow = useCallback(() => goToFlow(1), [goToFlow]);
  const previousFlow = useCallback(() => goToFlow(-1), [goToFlow]);

  const close = useCallback(() => {
    if (!flow) return;
    setFlowPlayback({ stage: 'closing' });
    frameFlow(flow, 'guided');
  }, [flow, frameFlow, setFlowPlayback]);

  const open = useCallback(() => {
    if (!flow) return;
    setFlowPlayback({ step: 0, stage: 'opening' });
    frameFlow(flow, 'guided');
  }, [flow, frameFlow, setFlowPlayback]);

  const next = useCallback(() => {
    if (stage === 'opening') goTo(1);
    else if (stage === 'closing') nextFlow();
    else if (flowPlayback.step >= steps.length) close();
    else goTo(flowPlayback.step + 1);
  }, [close, flowPlayback.step, goTo, nextFlow, stage, steps.length]);

  const previous = useCallback(() => {
    if (stage === 'closing') goTo(steps.length);
    else if (stage === 'opening') return;
    else if (flowPlayback.step <= 1) open();
    else goTo(flowPlayback.step - 1);
  }, [flowPlayback.step, goTo, open, stage, steps.length]);

  const first = useCallback(() => goTo(1), [goTo]);
  const last = useCallback(() => goTo(steps.length), [goTo, steps.length]);
  const replay = first;

  const overview = useCallback(() => {
    if (!flow) return;
    frameFlow(flow, stage === 'step' ? 'overview' : 'guided');
  }, [flow, frameFlow, stage]);

  const resumeFraming = useCallback(() => {
    if (!flow) return;
    // Nothing in flight is the presenter's any more: judge against the live camera.
    intended.current = null;
    useUiStore.getState().setPresentation({ framing: 'guided' });
    if (current) frameStepFor(current, { fresh: true });
    else frameFlow(flow, 'guided');
  }, [current, flow, frameFlow, frameStepFor]);

  // Deleting the connection you are standing on, or the flow itself, should
  // not strand playback in a broken state.
  useEffect(() => {
    if (!flowPlayback.active || flowPlayback.flowId === null) return; // Picker showing — nothing to reconcile yet.
    if (steps.length === 0) {
      // Losing the flow you were on is not a reason to lose the presentation. With other flows
      // still worth showing, fall back to the picker — the presenter picks up on another story
      // instead of being dropped back into the editor mid-sentence. Only with nothing left to
      // present does playback end outright. (`flowId: null` is the picker, which this effect's
      // own first line steps over, so there is no second pass.)
      setFlowPlayback(
        playableFlows.length > 0
          ? { active: true, flowId: null, step: 0, stage: undefined }
          : { active: false, flowId: null, step: 0, stage: undefined },
      );
      return;
    }
    if (flowPlayback.step > steps.length) setFlowPlayback({ step: steps.length });
  }, [flowPlayback.active, flowPlayback.flowId, flowPlayback.step, playableFlows.length, setFlowPlayback, steps.length]);

  // A step's own two-phase request/response pulse (see `DraftEdge.hasResponse`, `FlowPlaybackState.phase`).
  // Reset happens here, in exactly one place, keyed only on what actually identifies "a new step to
  // animate" — not scattered across `goTo`/`pickFlow`/the reconciliation effect/the edit-mode reset
  // above, which would need to individually remember to also patch `phase` (`setFlowPlayback`'s
  // shallow merge otherwise lets a stale `'response'` bleed into the next step). `current` is
  // deliberately not a dependency: it's derived from these same values one render later, and
  // listing it would just double-fire this effect on the render where it catches up.
  useEffect(() => {
    setFlowPlayback({ phase: 'request' });
    if (!current?.edge?.hasResponse) return;
    const timer = window.setTimeout(() => setFlowPlayback({ phase: 'response' }), RESPONSE_PHASE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- current intentionally excluded, see comment above.
  }, [flowPlayback.step, flowPlayback.flowId, flowPlayback.active, flowPlayback.stage, setFlowPlayback]);

  // The view changed size under a guided camera — the editor chrome leaving as presenting starts,
  // a window resized — so the same moment is framed again for the new size. A camera the presenter
  // took by hand, or pulled back to the overview, is theirs and stays where it is.
  const momentRef = useRef({ current, flow, stage, frameStepFor, frameFlow });
  momentRef.current = { current, flow, stage, frameStepFor, frameFlow };
  useEffect(() => {
    const moment = momentRef.current;
    if (!flowPlayback.active || !moment.flow || viewWidth === 0 || viewHeight === 0) return;
    if (useUiStore.getState().presentation.framing !== 'guided') return;
    if (moment.current) moment.frameStepFor(moment.current, { resize: true });
    else moment.frameFlow(moment.flow, 'guided', RESIZE_MS);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only a change of size reframes; the moment is read fresh.
  }, [viewWidth, viewHeight, flowPlayback.active]);

  // One stable object per actual change, so consumers keyed on it (`useKeyboard`'s window listener,
  // `useCommandContext`, `FlowBar`) don't tear down and rebuild on unrelated renders.
  return useMemo(
    () => ({
      flows: playableFlows,
      flow,
      flowIndex,
      steps,
      step: flowPlayback.step,
      current,
      active: flowPlayback.active,
      picking: flowPlayback.active && flowPlayback.flowId === null,
      stage,
      atEnd: stage === 'closing' && !upcoming,
      canStart: playableFlows.length > 0,
      start,
      pickFlow,
      stop,
      next,
      previous,
      goTo,
      first,
      last,
      replay,
      overview,
      resumeFraming,
      nextFlow,
      previousFlow,
    }),
    [
      playableFlows,
      flow,
      flowIndex,
      steps,
      flowPlayback,
      current,
      stage,
      upcoming,
      start,
      pickFlow,
      stop,
      next,
      previous,
      goTo,
      first,
      last,
      replay,
      overview,
      resumeFraming,
      nextFlow,
      previousFlow,
    ],
  );
}

const NO_EDGES: readonly DraftEdge[] = [];
const NO_NODES: readonly DraftNode[] = [];
