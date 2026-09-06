import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type FinalConnectionState,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { defaultTextFor } from '../document/factory';
import { descendantsOf } from '../document/operations';
import type { DraftDocument, Side } from '../document/types';
import { parseAnchorId, rectOf, snappedAnchorForDrop, type Rect } from '../edges/routing';
import { isEditableTarget } from '../lib/isEditableTarget';
import { useEditorStore } from '../store/editorStore';
import { pointer, useUiStore } from '../store/uiStore';
import { useThemeValue } from '../ui/theme/useTheme';
import { CanvasBackground } from './CanvasBackground';
import { ATTACH_DWELL_MS, deepestBoundaryAt, evaluateAttachCandidates } from './dragTargets';
import { findEdgeDropCandidate } from './edgeDropTarget';
import { DraftEdgeView } from './DraftEdgeView';
import { DraftNodeView } from './DraftNodeView';
import { Markers } from './Markers';
import {
  EDGE_COMPONENT,
  NODE_COMPONENT,
  projectEdges,
  projectNodes,
  resolveSelectedEdgeIds,
  sameSelection,
  type DraftRfEdge,
  type DraftRfNode,
} from './projection';
import { boundsOfRects, computeSnap, sameGuides, type Guide } from './snapping';

/**
 * These must be module-scope constants. An object literal defined during render
 * is a new identity every time, which makes React Flow remount every node on
 * every parent render — the classic way to make a canvas feel slow.
 */
const nodeTypes = { [NODE_COMPONENT]: DraftNodeView };
const edgeTypes = { [EDGE_COMPONENT]: DraftEdgeView };

const PRO_OPTIONS = { hideAttribution: true } as const;

/** How far the pointer may drift between a right-mousedown and the native `contextmenu` event
 *  before a menu open is suppressed as an unintentional gesture rather than a stationary click —
 *  its own independently-declared constant, per this file's usual "no shared clearance/threshold
 *  numbers across gestures" house style (see `DraftEdgeView.tsx`'s own `DRAG_THRESHOLD_PX`). */
const CONTEXT_MENU_DRAG_THRESHOLD_PX = 4;

/** How much further Presentation Mode dims a configured background, on top of
 *  the user's own setting — enough to recede further without disappearing. */
const PRESENTATION_EXTRA_DIM = 0.2;

interface ProjectionState {
  nodes: DraftRfNode[];
  edges: DraftRfEdge[];
  from: {
    document: DraftDocument;
    selectedNodes: ReadonlySet<string>;
    selectedEdges: ReadonlySet<string>;
    interactive: boolean;
  } | null;
}

const EMPTY_VIEW: ProjectionState = { nodes: [], edges: [], from: null };

const NO_SNAP = { changes: [] as NodeChange<DraftRfNode>[], guides: [] as Guide[] };

/**
 * Nudges an in-flight drag onto alignment with its neighbours, and reports the
 * guides to draw. Returns the changes untouched when nothing is close enough.
 */
function snapChanges(
  changes: NodeChange<DraftRfNode>[],
  current: readonly DraftRfNode[],
  statics: readonly Rect[],
): { changes: NodeChange<DraftRfNode>[]; guides: Guide[] } {
  const moves = changes.filter(
    (change) => change.type === 'position' && change.dragging === true && change.position,
  );
  if (moves.length === 0 || statics.length === 0) return { ...NO_SNAP, changes };

  const sizes = new Map(current.map((node) => [node.id, node]));
  const rects: Rect[] = [];
  for (const change of moves) {
    if (change.type !== 'position' || !change.position) continue;
    const node = sizes.get(change.id);
    rects.push({
      x: change.position.x,
      y: change.position.y,
      width: node?.width ?? node?.measured?.width ?? 0,
      height: node?.height ?? node?.measured?.height ?? 0,
    });
  }

  const bounds = boundsOfRects(rects);
  if (!bounds) return { ...NO_SNAP, changes };

  const snap = computeSnap(bounds, statics);
  if (snap.dx === 0 && snap.dy === 0) return { changes, guides: snap.guides };

  return {
    guides: snap.guides,
    changes: changes.map((change) =>
      change.type === 'position' && change.dragging === true && change.position
        ? { ...change, position: { x: change.position.x + snap.dx, y: change.position.y + snap.dy } }
        : change,
    ),
  };
}

/**
 * The resize counterpart to `snapChanges`, reusing the same `computeSnap`
 * math against the in-progress rect. A handle that moves the node's origin
 * (top or left) reports a `position` change alongside the `dimensions`
 * change in the same frame; when one is present, the snap delta is applied
 * to both position and (inversely) the matching dimension, so the opposite,
 * fixed edge does not drift. A handle that only grows/shrinks from the
 * bottom-right applies the delta to dimensions alone.
 */
function snapResizeChanges(
  changes: NodeChange<DraftRfNode>[],
  current: readonly DraftRfNode[],
  statics: readonly Rect[],
): { changes: NodeChange<DraftRfNode>[]; guides: Guide[] } {
  // Snapping applies equally to the terminal (`resizing: false`) frame —
  // that one commits to the document, so skipping it would mean the guide
  // shown mid-gesture never actually took effect. `resizing` is only ever
  // present (true or false) on a change dispatched by NodeResizer itself;
  // React Flow's own ResizeObserver fires dimension changes with no
  // `resizing` field at all whenever a node is first measured (on mount, or
  // whenever its DOM size changes for any other reason) — those must never
  // be mistaken for a live resize, or opening a diagram whose nodes happen
  // to already be aligned shows guides for a gesture that never happened.
  const resizing = changes.filter(
    (change) => change.type === 'dimensions' && change.dimensions && change.resizing !== undefined,
  );
  if (resizing.length === 0 || statics.length === 0) return { ...NO_SNAP, changes };

  const byId = new Map(current.map((node) => [node.id, node]));
  let result = changes;
  const guides: Guide[] = [];

  for (const change of resizing) {
    if (change.type !== 'dimensions' || !change.dimensions) continue;
    const node = byId.get(change.id);
    if (!node) continue;
    const posChange = changes.find(
      (c) => c.type === 'position' && c.id === change.id && c.position,
    );
    const posChangePosition = posChange?.type === 'position' ? posChange.position : undefined;
    const position = posChangePosition ?? node.position;
    const rect: Rect = { ...position, width: change.dimensions.width, height: change.dimensions.height };

    const snap = computeSnap(rect, statics);
    guides.push(...snap.guides);
    if (snap.dx === 0 && snap.dy === 0) continue;

    result = result.map((c) => {
      if (c.type === 'dimensions' && c.id === change.id && c.dimensions) {
        const width = posChangePosition ? c.dimensions.width - snap.dx : c.dimensions.width + snap.dx;
        const height = posChangePosition ? c.dimensions.height - snap.dy : c.dimensions.height + snap.dy;
        return { ...c, dimensions: { width: Math.max(1, width), height: Math.max(1, height) } };
      }
      if (c.type === 'position' && c.id === change.id && c.position) {
        return { ...c, position: { x: c.position.x + snap.dx, y: c.position.y + snap.dy } };
      }
      return c;
    });
  }

  return { changes: result, guides };
}

/**
 * Carries a dragged boundary's contents along with it. React Flow has no idea
 * `parentId` exists — this document-level containment concept never reaches
 * it (`projectNodes` never sets React Flow's own `parentId`/`parentNode`), so
 * a boundary's descendants are not part of React Flow's own drag gesture at
 * all. Each frame, every swept descendant is repositioned by the same delta
 * the boundary itself has moved, measured against the committed document
 * (which does not change mid-drag).
 */
function sweepDescendants(
  nodes: DraftRfNode[],
  swept: ReadonlyMap<string, readonly string[]>,
  doc: DraftDocument,
): DraftRfNode[] {
  if (swept.size === 0) return nodes;
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const liveById = new Map(nodes.map((node) => [node.id, node]));
  const patches = new Map<string, { x: number; y: number }>();

  for (const [groupId, descendantIds] of swept) {
    const liveGroup = liveById.get(groupId);
    const docGroup = byId.get(groupId);
    if (!liveGroup || !docGroup) continue;
    const dx = liveGroup.position.x - docGroup.x;
    const dy = liveGroup.position.y - docGroup.y;
    if (dx === 0 && dy === 0) continue;
    for (const id of descendantIds) {
      const docNode = byId.get(id);
      if (docNode) patches.set(id, { x: docNode.x + dx, y: docNode.y + dy });
    }
  }
  if (patches.size === 0) return nodes;
  return nodes.map((node) => {
    const patch = patches.get(node.id);
    return patch ? { ...node, position: patch } : node;
  });
}

export interface CanvasProps {
  /** Called when an armed tool is placed at a point on the canvas (toolbar click, or double-click with a tool armed). */
  onCreateAt?: (position: { x: number; y: number }) => void;
  /**
   * Called instead of creating a node when a connection is dragged onto empty
   * canvas — the caller opens a small type picker and creates+connects once
   * the user chooses, rather than guessing a type immediately.
   */
  onQuickConnectMenu?: (
    sourceId: string,
    sourceSide: Side | undefined,
    sourceOffset: number | undefined,
    flowPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
  ) => void;
  /**
   * Called instead of `onCreateAt` when the canvas is double-clicked with no
   * tool armed — there is no default "blank" type to guess, so the caller
   * opens the same type picker `onQuickConnectMenu` uses, just with no
   * source node to wire up afterward.
   */
  onEmptyCanvasMenu?: (
    flowPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
  ) => void;
}

export function Canvas({ onCreateAt, onQuickConnectMenu, onEmptyCanvasMenu }: CanvasProps) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const explainActive = useEditorStore((state) => state.flowPlayback.active);
  const focusActive = useEditorStore((state) => state.focus.active);
  // A flow merely selected (not presented) acts as a gentler lens — see
  // `docs/ARCHITECTURE.md`'s "Flows and presentation". Suppressed whenever
  // Presentation or Focus already own the dimming, exactly the mutual
  // exclusion those two already have.
  const lensActive = useEditorStore(
    (state) => state.selectedFlowId !== null && !state.flowPlayback.active && !state.focus.active,
  );
  const theme = useThemeValue();

  const store = useEditorStore;
  const { screenToFlowPosition, flowToScreenPosition, getNodes } = useReactFlow();

  const interactive = mode === 'edit';

  const [guides, setGuides] = useState<Guide[]>([]);
  const attachArmedTarget = useUiStore((state) => state.attachArmedTarget);
  const attachTarget = attachArmedTarget
    ? document.nodes.find((node) => node.id === attachArmedTarget)
    : undefined;

  /** Rectangles of everything not being dragged, rebuilt once per gesture. */
  const staticRects = useRef<Rect[]>([]);
  const draggingIds = useRef<Set<string>>(new Set());
  /** Same idea for a resize gesture — resize starts inside `DraftNodeView`,
   *  not `onNodeDragStart`, so this is (re)built lazily, the first frame a
   *  new resizing node id is seen, rather than eagerly at gesture start. */
  const resizeStaticRects = useRef<Rect[]>([]);
  const resizingNodeId = useRef<string | null>(null);
  /** Dragged boundary id → its descendant ids, for the current gesture only. */
  const sweptDescendants = useRef<Map<string, string[]>>(new Map());
  /**
   * Attach-arming dwell: while the pointer sits still, React Flow fires no
   * further drag events at all, so elapsed time can't be checked from inside
   * `onNodesChange` — it must be a real timer, armed independently once a
   * frame reports the dragged node's centre sitting over a candidate.
   */
  const dwellTimer = useRef<number | null>(null);
  const dwellTargetId = useRef<string | null>(null);
  /** Where the right mouse button went down, in screen coordinates — compared against the native
   *  `contextmenu` event's own position to tell a stationary right-click from a right-drag. */
  const rightPointerDown = useRef<{ x: number; y: number } | null>(null);
  const clearDwell = useCallback(() => {
    if (dwellTimer.current !== null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    dwellTargetId.current = null;
  }, []);
  // Every other call site clears the dwell timer at a specific gesture
  // event; nothing previously cleared it if `Canvas` itself unmounted
  // mid-dwell (e.g. closing the document mid-drag).
  useEffect(() => clearDwell, [clearDwell]);

  const selectedNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);
  const selectedEdges = useMemo(() => new Set(selection.edges), [selection.edges]);

  // React Flow's own marquee (rubber-band) selection state — see `onEdgesChange`
  // for why this is read here.
  const userSelectionActive = useStore((state) => state.userSelectionActive);

  /**
   * The rendered arrays are derived from the document during render rather than
   * synced in an effect, so a document change costs one render instead of two.
   * `from` records the inputs the current projection was built from; while a
   * drag is in flight the document does not change, so the live positions in
   * `view` are left alone.
   */
  const [view, setView] = useState<ProjectionState>(EMPTY_VIEW);

  if (
    view.from === null ||
    view.from.document !== document ||
    view.from.selectedNodes !== selectedNodes ||
    view.from.selectedEdges !== selectedEdges ||
    view.from.interactive !== interactive
  ) {
    const options = { selectedNodes, selectedEdges, interactive };
    setView((current) => ({
      nodes: projectNodes(document, current.nodes, options),
      edges: projectEdges(document, current.edges, options),
      from: { document, selectedNodes, selectedEdges, interactive },
    }));
  }

  const { nodes, edges } = view;
  const setNodes = useCallback(
    (update: (current: DraftRfNode[]) => DraftRfNode[]) =>
      setView((current) => {
        const next = update(current.nodes);
        return next === current.nodes ? current : { ...current, nodes: next };
      }),
    [],
  );

  /**
   * Position and size changes stream in per frame while a gesture runs.
   *
   * Snapping is applied to the change *before* it is applied, rather than by
   * repositioning the node afterwards: React Flow derives each frame's position
   * from the pointer delta against its own stored origin, so a correction
   * applied after the fact is simply overwritten on the next frame, and the
   * node ends up somewhere between the two.
   *
   * The document is only written when the gesture ends, which is what makes one
   * drag one undo entry and stops autosave firing sixty times a second.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange<DraftRfNode>[]) => {
      const liveNodes = getNodes() as DraftRfNode[];
      const snappedMove = snapChanges(changes, liveNodes, staticRects.current);

      // A dimensions change appears on every frame of a resize gesture,
      // including the terminal one (`resizing: false`) that commits to the
      // document — the static rects must still be populated for that frame,
      // so the reset below happens *after* this frame's snap, not before it.
      // `resizing !== undefined` is what distinguishes an actual NodeResizer
      // gesture from React Flow's own auto-measurement dimension changes
      // (fired on mount, or whenever a node's DOM size changes for any other
      // reason), which never carry that field — without this guard, opening
      // a diagram whose nodes happen to already be aligned would arm the
      // resize-snap machinery and show guides for a gesture that never
      // happened.
      const dimChange = changes.find(
        (change): change is Extract<NodeChange<DraftRfNode>, { type: 'dimensions' }> =>
          change.type === 'dimensions' && Boolean(change.dimensions) && change.resizing !== undefined,
      );
      if (dimChange && resizingNodeId.current !== dimChange.id) {
        resizingNodeId.current = dimChange.id;
        resizeStaticRects.current = store
          .getState()
          .document.nodes.filter((node) => node.id !== dimChange.id)
          .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
      }
      const snapped = snapResizeChanges(snappedMove.changes, liveNodes, resizeStaticRects.current);
      // A move and a resize are never in progress in the same gesture, so at
      // most one side of this ever has guides to show. The terminal resize
      // frame (`resizing: false`) still reports a snap-adjusted dimensions
      // change here, but the gesture is over — showing its guide would leave
      // it stuck on screen forever, since (unlike a drag) nothing else ever
      // runs to clear it afterward.
      const guides = dimChange?.resizing === false ? [] : [...snappedMove.guides, ...snapped.guides];

      if (dimChange?.resizing === false) {
        resizingNodeId.current = null;
        resizeStaticRects.current = [];
      }

      // Attach-arming only applies to a genuine single-node drag — never a
      // multi-select move, and never the sweep a dragged boundary causes.
      if (draggingIds.current.size === 1 && sweptDescendants.current.size === 0) {
        const [draggedId] = draggingIds.current;
        const state = store.getState();
        const draggedDoc = state.document.nodes.find((n) => n.id === draggedId);
        const posChange = snapped.changes.find(
          (change) => change.type === 'position' && change.id === draggedId,
        );
        const livePosition = posChange?.type === 'position' ? posChange.position : undefined;
        // A frame with no real position for the dragged node — notably React
        // Flow's own drag-end pseudo-frame, which only flips `dragging` to
        // false and carries no `position` at all — must not re-evaluate
        // arming by falling back to the node's stale, still-uncommitted
        // document position: that silently overwrites whatever the last real
        // move frame correctly armed with a result computed for the wrong
        // (pre-drag) location, moments before `onNodeDragStop` reads it.
        // Leaving the existing armed state untouched here is what fixed a
        // real, reproducible failure to attach a dragged note/code card onto
        // a connector right at the very end of the gesture.
        if (draggedDoc && livePosition) {
          const liveRect: Rect = { ...livePosition, width: draggedDoc.width, height: draggedDoc.height };
          const exclude = new Set([draggedDoc.id, ...descendantsOf(state.document, draggedDoc.id)]);
          const { overlapId, centerHitId } = evaluateAttachCandidates(
            liveRect,
            draggedDoc.type,
            state.document,
            exclude,
          );

          if (overlapId) {
            clearDwell();
            useUiStore.getState().setAttachArmedTarget(overlapId);
            useUiStore.getState().setAttachArmedEdgeTarget(null);
          } else if (centerHitId) {
            if (dwellTargetId.current !== centerHitId) {
              clearDwell();
              dwellTargetId.current = centerHitId;
              dwellTimer.current = window.setTimeout(() => {
                if (dwellTargetId.current === centerHitId) {
                  useUiStore.getState().setAttachArmedTarget(centerHitId);
                }
              }, ATTACH_DWELL_MS);
            }
            // Armed for a stale target (an overlap winner that no longer
            // applies, or a previous dwell target) while this dwell is still
            // pending is not a valid armed state — only the dwell firing (or
            // an overlap hit above) may arm this exact target.
            const armed = useUiStore.getState().attachArmedTarget;
            if (armed !== null && armed !== centerHitId) useUiStore.getState().setAttachArmedTarget(null);
            useUiStore.getState().setAttachArmedEdgeTarget(null);
          } else if (draggedDoc.type === 'note' || draggedDoc.type === 'code') {
            // No node claimed this drop — a note/code card dragged onto a connector's own
            // hit corridor folds it into that connector's attachment instead. Reuses the exact
            // same corridor a click already uses (`findEdgeDropCandidate`), so this is precise
            // enough to arm instantly, the same way a strong node overlap does above — no dwell.
            clearDwell();
            useUiStore.getState().setAttachArmedTarget(null);
            const center = {
              x: liveRect.x + liveRect.width / 2,
              y: liveRect.y + liveRect.height / 2,
            };
            const screenPoint = flowToScreenPosition(center);
            const edgeId = findEdgeDropCandidate(screenPoint.x, screenPoint.y, draggedDoc.id);
            useUiStore.getState().setAttachArmedEdgeTarget(edgeId);
          } else {
            clearDwell();
            useUiStore.getState().setAttachArmedTarget(null);
            useUiStore.getState().setAttachArmedEdgeTarget(null);
          }
        }
      } else {
        clearDwell();
        useUiStore.getState().setAttachArmedTarget(null);
        useUiStore.getState().setAttachArmedEdgeTarget(null);
      }

      setNodes((current) => {
        const next = applyNodeChanges(snapped.changes, current);
        return sweepDescendants(next, sweptDescendants.current, store.getState().document);
      });

      // Guides appear and disappear; they do not move every frame. Updating
      // state only when the set actually changes is what keeps drags smooth.
      setGuides((current) => (sameGuides(current, guides) ? current : guides));

      // Committing from `snapped.changes` (not the raw `changes` argument) is
      // what makes the terminal frame's snap correction actually stick — the
      // raw terminal change still carries React Flow's own unsnapped size.
      for (const change of snapped.changes) {
        if (change.type === 'dimensions' && change.resizing === false) {
          const resized = change.dimensions;
          if (resized) {
            store
              .getState()
              .updateNodeById(change.id, { width: resized.width, height: resized.height }, 'Resize');
          }
        }
      }
    },
    [clearDwell, flowToScreenPosition, getNodes, setNodes, store],
  );

  const setEdges = useCallback(
    (update: (current: DraftRfEdge[]) => DraftRfEdge[]) =>
      setView((current) => {
        const next = update(current.edges);
        return next === current.edges ? current : { ...current, edges: next };
      }),
    [],
  );

  /**
   * Edges are a controlled prop, so React Flow cannot mark one selected on its
   * own — for an ordinary click, this handler's `'select'` change is the only
   * place that ever happens, and skipping it would make clicking a connector
   * do nothing.
   *
   * A marquee (rubber-band) drag is different: React Flow drives edge
   * selection there through a second, internal pathway that bypasses the
   * controlled `edges` prop entirely (it selects every edge connected to a
   * newly-selected node directly in its own store), and *also* still calls
   * this handler with the equivalent `'select'` change. Applying both is a
   * race — this handler's patch to `view.edges` and the subsequent
   * `onSelectionChange` → `store.selection.edges` → `projectEdges` patch
   * could each make React Flow see the result as a further change, looping
   * forever ("Maximum update depth exceeded", crashing the whole app) the
   * moment a marquee drag included any edge. So only during a marquee is a
   * `'select'` change here redundant with what the store-driven path is
   * about to do anyway — skip it exactly then, and only then.
   *
   * `userSelectionActive` is React Flow's own store flag for "a marquee is
   * in progress" (read via `useStore` above), not a ref this file maintains
   * itself — React Flow resets it unconditionally on every qualifying
   * pointer-up via native pointer capture, so it can't desync from what's
   * actually happening the way a hand-rolled ref tracking the same thing
   * could (e.g. if an interrupted gesture ever left a local ref stuck).
   */
  const onEdgesChange = useCallback(
    (changes: EdgeChange<DraftRfEdge>[]) => {
      const rest = userSelectionActive
        ? changes.filter((change) => change.type !== 'select')
        : changes;
      if (rest.length === 0) return;
      setEdges((current) => applyEdgeChanges(rest, current));
    },
    [setEdges, userSelectionActive],
  );

  /**
   * `resolveSelectedEdgeIds` fixes the one specific way React Flow's own post-marquee selection
   * report is known to disagree with itself forever (two or more edges sharing a newly-(un)
   * selected node) — but it is not the only way that has happened across this app's history (see
   * the other "hardening pass" commits touching this file), and a *new* variant surfaced even
   * after that fix shipped: the reported *node* list itself, not just its edges, alternating
   * between empty and full call after call. Patching each newly-discovered oscillation
   * individually never closes off the next one, because the actual bug lives inside React Flow's
   * own internal box-selection bookkeeping, not in anything this app can fully audit.
   *
   * `selectionBurst` is the backstop for whatever the next one turns out to be. A normal
   * interaction — even an enthusiastic marquee sweeping many nodes one at a time as the box grows
   * — calls this a handful of times; only a genuine feedback loop calls it dozens of times inside
   * one short window. Below `SELECTION_BURST_LIMIT`, every call still commits to `store.selection`
   * synchronously, exactly as before — callers that act on the selection immediately after a
   * click (delete-via-Backspace, Enter-to-edit, and the like) depend on that. Only once a burst is
   * detected does it stop committing synchronously and start coalescing: the *latest* report is
   * held in `pendingSelectionRef` and committed on the next animation frame instead, so a run of
   * calls that would otherwise each be a further synchronous re-render collapses into one commit
   * per frame. If React Flow's own report is genuinely unstable this keeps it unstable — the
   * selection may still flicker — but each commit now happens in its own animation-frame callback
   * rather than as a continuation of the last render, so React's own nested-update counter (the
   * thing that throws "Maximum update depth exceeded") gets to reset between them and can never
   * be exhausted. A crash becomes, at worst, a rare visual flicker.
   */
  const SELECTION_BURST_WINDOW_MS = 300;
  const SELECTION_BURST_LIMIT = 10;
  const selectionBurst = useRef({ count: 0, windowEndsAt: 0 });
  const pendingSelectionRef = useRef<{ nodes: string[]; edges: string[] } | null>(null);
  const selectionFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (selectionFrameRef.current !== null) cancelAnimationFrame(selectionFrameRef.current);
    },
    [],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodeList, edges: selectedEdgeList }: OnSelectionChangeParams) => {
      const nodeIds = selectedNodeList.map((node) => node.id);
      // Compares against whatever the *next* commit will actually see — a still-pending report
      // from earlier this same burst, if there is one, not the (about to be stale) store value.
      const baseline = pendingSelectionRef.current ?? store.getState().selection;
      // See `resolveSelectedEdgeIds`'s own doc comment (`projection.ts`) for why this can't
      // just trust React Flow's reported `selectedEdgeList` unconditionally.
      const edgeIds = resolveSelectedEdgeIds(
        nodeIds,
        baseline.nodes,
        selectedEdgeList.map((edge) => edge.id),
        store.getState().document.edges,
      );
      const next = { nodes: nodeIds, edges: edgeIds };
      if (sameSelection(baseline, next)) return;

      const now = performance.now();
      const burst = selectionBurst.current;
      if (now > burst.windowEndsAt) burst.count = 0;
      burst.count += 1;
      burst.windowEndsAt = now + SELECTION_BURST_WINDOW_MS;

      if (burst.count <= SELECTION_BURST_LIMIT) {
        store.getState().setSelection(next);
        return;
      }
      pendingSelectionRef.current = next;
      if (selectionFrameRef.current === null) {
        selectionFrameRef.current = requestAnimationFrame(() => {
          selectionFrameRef.current = null;
          const pending = pendingSelectionRef.current;
          pendingSelectionRef.current = null;
          if (pending) store.getState().setSelection(pending);
        });
      }
    },
    [store],
  );

  /**
   * React Flow reports exactly which nodes the gesture is moving — the whole
   * selection when the grab started on a selected node, otherwise just the one
   * under the cursor. Deriving it from our own selection instead would commit
   * the wrong node's position whenever those two disagree.
   */
  const onNodeDragStart = useCallback(
    (_event: unknown, _node: DraftRfNode, dragged: DraftRfNode[]) => {
      const state = store.getState();
      state.beginInteraction('Move');
      useUiStore.getState().setInteractionActive(true);

      const moving = new Set(dragged.map((node) => node.id));
      draggingIds.current = moving;

      const swept = new Map<string, string[]>();
      for (const node of dragged) {
        const doc = state.document.nodes.find((n) => n.id === node.id);
        if (doc?.type !== 'group') continue;
        const descendants = descendantsOf(state.document, doc.id).filter((id) => !moving.has(id));
        if (descendants.length > 0) {
          swept.set(doc.id, descendants);
          for (const id of descendants) moving.add(id);
        }
      }
      sweptDescendants.current = swept;
      clearDwell();
      useUiStore.getState().setAttachArmedTarget(null);
      useUiStore.getState().setAttachArmedEdgeTarget(null);

      staticRects.current = state.document.nodes
        .filter((node) => !moving.has(node.id))
        .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
    },
    [clearDwell, store],
  );

  /**
   * Committing the drag reads the final positions from React Flow rather than
   * from inside a state updater. Updaters must stay pure: React invokes them
   * twice in development, which would write the move to history twice and make
   * a single undo look like it did nothing.
   *
   * A single node's drop can mean three different things, checked in this
   * order: (1) it was armed against an attach target — fold it into that
   * host's attachments; (2) failing that, its centre landed inside a
   * boundary (the deepest one, if several are nested) — reparent it there,
   * or clear its parent if it landed on bare canvas; (3) otherwise it is
   * simply a move. A multi-node drag (marquee, or a boundary sweeping its
   * contents) is always just a move — attach and reparent are deliberately
   * restricted to a single, unambiguous node.
   */
  const onNodeDragStop = useCallback(() => {
    setGuides([]);
    const state = store.getState();
    const draggedIds = draggingIds.current;
    const rfNodes = getNodes();
    const positions = new Map(
      rfNodes
        .filter((node) => draggedIds.has(node.id))
        .map((node) => [node.id, { x: node.position.x, y: node.position.y }] as const),
    );

    const singleId = draggedIds.size === 1 && sweptDescendants.current.size === 0 ? [...draggedIds][0]! : null;
    const armedHost = useUiStore.getState().attachArmedTarget;
    const armedEdge = useUiStore.getState().attachArmedEdgeTarget;

    if (singleId && armedHost) {
      positions.delete(singleId);
      if (positions.size > 0) state.commitPositions(positions);
      state.attachExistingNode(singleId, armedHost);
    } else if (singleId && armedEdge) {
      positions.delete(singleId);
      if (positions.size > 0) state.commitPositions(positions);
      state.attachExistingNodeToEdge(singleId, armedEdge);
    } else {
      const draggedDoc = singleId ? state.document.nodes.find((n) => n.id === singleId) : undefined;
      const finalPosition = singleId ? positions.get(singleId) : undefined;
      if (positions.size > 0) state.commitPositions(positions);

      if (draggedDoc && draggedDoc.type !== 'group' && finalPosition) {
        const center = {
          x: finalPosition.x + draggedDoc.width / 2,
          y: finalPosition.y + draggedDoc.height / 2,
        };
        const exclude = new Set([draggedDoc.id, ...descendantsOf(state.document, draggedDoc.id)]);
        const boundaryId = deepestBoundaryAt(center, state.document, exclude);
        if (boundaryId !== (draggedDoc.parentId ?? null)) {
          state.reparentNode(draggedDoc.id, boundaryId);
        }
      }
    }

    state.endInteraction();
    useUiStore.getState().setInteractionActive(false);
    draggingIds.current = new Set();
    sweptDescendants.current = new Map();
    clearDwell();
    useUiStore.getState().setAttachArmedTarget(null);
    useUiStore.getState().setAttachArmedEdgeTarget(null);
  }, [clearDwell, getNodes, store]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // A handle id encodes exactly which of the 12 anchors it is (see
      // `HANDLE_ANCHORS`/`parseAnchorId` in `edges/routing.ts`), so this is
      // the drag's actual start/end point, not a guess — see `EdgeAnchor` in
      // `document/types.ts`.
      const sourceAnchor = parseAnchorId(connection.sourceHandle);
      const targetAnchor = parseAnchorId(connection.targetHandle);
      store
        .getState()
        .connect(
          connection.source,
          connection.target,
          sourceAnchor?.side,
          targetAnchor?.side,
          sourceAnchor?.offset,
          targetAnchor?.offset,
        );
    },
    [store],
  );

  /**
   * Where a dragged connection ends decides what happens.
   *
   * On a handle, React Flow has already made the connection. Anywhere on a
   * node's body, we make it here — insisting the user hit a nine-pixel dot is
   * exactly the fiddling this tool exists to avoid. On empty canvas, the node
   * the connection was heading for is created, so building a flow stays one
   * continuous gesture rather than create, aim, connect, repeat.
   */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid) return;
      const source = connectionState.fromNode?.id;
      if (!source) return;
      const sourceAnchor = parseAnchorId(connectionState.fromHandle?.id);

      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      const state = store.getState();

      // React Flow only reports `toNode` when the pointer is within the
      // connection radius of a handle, so anywhere else on a node counts as a
      // miss. Hit-testing the drop point against node rectangles ourselves is
      // what makes "drag onto that box" work the way people expect.
      const droppedOn = [...state.document.nodes]
        .filter((node) => node.type !== 'group')
        .sort((a, b) => b.z - a.z)
        .find(
          (node) =>
            position.x >= node.x &&
            position.x <= node.x + node.width &&
            position.y >= node.y &&
            position.y <= node.y + node.height,
        );

      if (droppedOn) {
        if (droppedOn.id !== source) {
          // A body-hit, not a handle — a drop that clearly favours one side
          // attaches close to where the user actually dropped it (snapped to
          // the same 3-point grid a real handle sits on); a drop near dead
          // centre keeps the dynamic side choice `chooseSides` would pick
          // anyway. See `snappedAnchorForDrop` in `edges/routing.ts`.
          const targetAnchor = snappedAnchorForDrop(rectOf(droppedOn), position);
          state.connect(
            source,
            droppedOn.id,
            sourceAnchor?.side,
            targetAnchor?.side,
            sourceAnchor?.offset,
            targetAnchor?.offset,
          );
        }
        return;
      }

      // Empty canvas: defer to the caller's Quick Connect picker rather than
      // guessing a type — the whole point is that the choice, not a guess,
      // decides what appears.
      onQuickConnectMenu?.(
        source,
        sourceAnchor?.side,
        sourceAnchor?.offset,
        { x: Math.round(position.x - 88), y: Math.round(position.y - 34) },
        { x: point.clientX, y: point.clientY },
      );
    },
    [onQuickConnectMenu, screenToFlowPosition, store],
  );

  // Reconnecting an existing connector's endpoint is driven entirely by hand
  // in `DraftEdgeView.tsx`'s `EdgeEndpointHandle`, not through React Flow's
  // `onReconnect`/`edgesReconnectable` — see the long comment there for why:
  // a node's own connection handles always keep real pointer events (even
  // invisible), and being painted later in the DOM than an edge's SVG layer,
  // they physically intercept a pointer-down aimed at React Flow's built-in
  // reconnect hit zone whenever the two coincide, which they almost always
  // do. `document/operations.ts`'s `reconnectEdge` — the actual document
  // mutation — is unaffected; only what triggers it moved.

  /**
   * The selection as it stood the instant the right button went down — read again inside
   * `onNodeContextMenu`/`onEdgeContextMenu` instead of a fresh `store.getState().selection`, because
   * by the time those fire, React Flow's own default click-to-select handling (on the node/edge's
   * own wrapper, a descendant of this div) has already run and collapsed the selection to just the
   * clicked element — confirmed empirically, not assumed. Capturing here, on `onPointerDownCapture`
   * (the capture phase always reaches an ancestor before any bubble-phase handler on a descendant
   * runs, regardless of DOM position), is what gets ahead of that collapse.
   */
  const selectionAtRightPointerDown = useRef<{ nodes: string[]; edges: string[] } | null>(null);

  const onCanvasPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 2) return;
      rightPointerDown.current = { x: event.clientX, y: event.clientY };
      selectionAtRightPointerDown.current = store.getState().selection;
    },
    [store],
  );

  /** True once the pointer has moved past `CONTEXT_MENU_DRAG_THRESHOLD_PX` since the right button
   *  went down — a real gesture (jitter aside), not a click, so no menu should open for it. */
  const movedPastContextMenuThreshold = useCallback((event: { clientX: number; clientY: number }) => {
    const down = rightPointerDown.current;
    if (!down) return false;
    return Math.hypot(event.clientX - down.x, event.clientY - down.y) > CONTEXT_MENU_DRAG_THRESHOLD_PX;
  }, []);

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      if (!interactive) return;
      // A right-click landing inside a text field (there's no such surface on the bare pane today,
      // but see `onNodeContextMenu`) must never hijack the browser's own Copy/Paste menu.
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      if (movedPastContextMenuThreshold(event)) return;
      // Matches the existing plain-left-click-on-empty-canvas precedent (React Flow's own default
      // pane-click deselect) — a right-click on empty canvas is the same "click on nothing" gesture.
      store.getState().setSelection({ nodes: [], edges: [] });
      // The literal click point, in flow coordinates — no centering offset here. "Add X" needs one
      // (a node's `x`/`y` is its top-left, not its center), but "Paste" wants the raw point, since
      // `paste()` already computes its own offset from the pasted fragment's own bounding box; the
      // `-88,-34` convention is applied only at the "Add X" call site, inside `contextMenuCommandsFor`.
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      useUiStore.getState().setContextMenu({
        target: { kind: 'pane' },
        screenPosition: { x: event.clientX, y: event.clientY },
        flowPosition: { x: Math.round(position.x), y: Math.round(position.y) },
      });
    },
    [interactive, movedPastContextMenuThreshold, screenToFlowPosition, store],
  );

  /**
   * Right-clicking a node that's already part of a multi-selection must preserve the whole
   * selection and open the multi-selection menu — never collapse it down to just the clicked
   * element (spec's own selection semantics). Right-clicking anything else (unselected, or the
   * single already-selected node) replaces the selection with just that node, same as a plain
   * left-click would.
   */
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: DraftRfNode) => {
      if (!interactive) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      if (movedPastContextMenuThreshold(event)) return;
      // The pre-click snapshot, not a fresh read — see `selectionAtRightPointerDown`'s own comment.
      const before = selectionAtRightPointerDown.current ?? store.getState().selection;
      const partOfMultiSelection = before.nodes.length + before.edges.length >= 2 && before.nodes.includes(node.id);
      // Either restore the multi-selection React Flow's own default click handling already
      // collapsed by this point, or replace it with just the clicked node — never leave the live
      // store holding that collapsed-to-one-node state.
      store.getState().setSelection(partOfMultiSelection ? before : { nodes: [node.id], edges: [] });
      useUiStore.getState().setContextMenu({
        target: partOfMultiSelection ? { kind: 'selection' } : { kind: 'node', id: node.id },
        screenPosition: { x: event.clientX, y: event.clientY },
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [interactive, movedPastContextMenuThreshold, screenToFlowPosition, store],
  );

  /** Mirrors `onNodeContextMenu` exactly, just against `selection.edges` — see its own comment. */
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: DraftRfEdge) => {
      if (!interactive) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      if (movedPastContextMenuThreshold(event)) return;
      const before = selectionAtRightPointerDown.current ?? store.getState().selection;
      const partOfMultiSelection = before.nodes.length + before.edges.length >= 2 && before.edges.includes(edge.id);
      store.getState().setSelection(partOfMultiSelection ? before : { nodes: [], edges: [edge.id] });
      useUiStore.getState().setContextMenu({
        target: partOfMultiSelection ? { kind: 'selection' } : { kind: 'edge', id: edge.id },
        screenPosition: { x: event.clientX, y: event.clientY },
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [interactive, movedPastContextMenuThreshold, screenToFlowPosition, store],
  );

  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!interactive) return;
      // React Flow has no `onPaneDoubleClick`, so this fires for the whole
      // canvas — including double-clicks on a node, which mean "edit this
      // label" and must not also drop a new element underneath it.
      const target = event.target as HTMLElement | null;
      if (!target?.classList.contains('react-flow__pane')) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const flowPosition = { x: Math.round(position.x - 88), y: Math.round(position.y - 34) };

      // A tool already armed (toolbar click) places that specific type, same
      // as a single click would. With nothing armed there is no default
      // "blank" type to guess anymore, so the caller opens a type picker
      // instead — see `onEmptyCanvasMenu`.
      if (useUiStore.getState().armed) {
        onCreateAt?.(flowPosition);
        return;
      }
      onEmptyCanvasMenu?.(flowPosition, { x: event.clientX, y: event.clientY });
    },
    [interactive, onCreateAt, onEmptyCanvasMenu, screenToFlowPosition],
  );

  /** A toolbar button arms a tool; the next click on empty canvas places it. */
  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!interactive || !useUiStore.getState().armed) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onCreateAt?.({ x: Math.round(position.x - 88), y: Math.round(position.y - 34) });
    },
    [interactive, onCreateAt, screenToFlowPosition],
  );

  /**
   * Keyboard shortcuts create an element under the cursor, so the pointer
   * position is tracked outside React — re-rendering the canvas on every mouse
   * move to keep it in state would be indefensible.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      pointer.x = position.x;
      pointer.y = position.y;
      pointer.known = true;
    },
    [screenToFlowPosition],
  );

  const onMoveEnd = useCallback(
    (_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
      // Persisted as document state, deliberately not as an undo step: nobody
      // wants Ctrl+Z to undo a scroll.
      store.getState().persistViewport(viewport);
    },
    [store],
  );

  const grid = document.settings.grid;

  return (
    <div
      className="dc-canvas"
      data-explain={explainActive ? 'on' : undefined}
      data-focus={focusActive ? 'on' : undefined}
      data-lens={lensActive ? 'on' : undefined}
      onPointerDownCapture={onCanvasPointerDown}
    >
      <CanvasBackground
        settings={document.settings.background}
        documentId={document.metadata.id}
        extraDim={explainActive ? PRESENTATION_EXTRA_DIM : 0}
      />
      <Markers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onDoubleClick={onPaneDoubleClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onPointerMove={onPointerMove}
        onMoveEnd={onMoveEnd}
        defaultViewport={document.viewport}
        minZoom={0.1}
        maxZoom={4}
        // Every handle both starts and accepts a connection. Strict mode would
        // force the user to aim at the one handle designated as a target, which
        // is exactly the fiddling this tool exists to avoid.
        connectionMode={ConnectionMode.Loose}
        // Slightly past React Flow's own default (20px) — with 3 handles per
        // side now sitting closer together, this is what lets its native
        // nearest-handle highlight/snap (`.connectingto.valid`) still engage
        // without pixel-precision aim, while staying short enough that a drop
        // near a small node's centre still falls through to `onConnectEnd`'s
        // own dynamic-routing dead zone (`CENTER_DROP_TOLERANCE`) instead of
        // always resolving to one specific handle.
        connectionRadius={28}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        elementsSelectable={interactive}
        panOnScroll
        selectionOnDrag={interactive}
        // Button 1 (middle-mouse-drag) still pans; button 2 (right) is freed for the context menu —
        // see `onPaneContextMenu`'s own comment for why React Flow's `Pane` would otherwise swallow
        // the native `contextmenu` event before it ever reaches that handler.
        panOnDrag={interactive ? [1] : true}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={['Meta', 'Shift', 'Control']}
        proOptions={PRO_OPTIONS}
        colorMode={theme.name}
        connectionLineStyle={{ stroke: theme.selection, strokeWidth: 1.8 }}
      >
        {grid !== 'none' && (
          <Background
            variant={grid === 'lines' ? BackgroundVariant.Lines : BackgroundVariant.Dots}
            gap={grid === 'lines' ? 32 : 22}
            size={grid === 'lines' ? 1 : 1.4}
            color={theme.grid}
            // React Flow's own grid layer paints an opaque backdrop by
            // default — without this, it silently covers `.dc-canvas`'s own
            // background (and, since Phase 5.1, a configured background
            // image) with its own dark fill, coincidentally close enough to
            // the app's dark theme that this went unnoticed until now.
            bgColor="transparent"
          />
        )}

        <ViewportPortal>
          {/*
            Both of these are drag-in-progress chrome, meaningless once the
            gesture that produced them ends — and impossible to produce at all
            in present mode, where dragging and resizing are disabled. Gating
            on `interactive` here (rather than relying solely on clearing the
            state at the right moment) means a stale value can never render,
            including across a mode switch mid-gesture.
          */}
          {interactive &&
            guides.map((guide, index) => (
              <div
                key={`${guide.axis}-${index}`}
                className="dc-guide"
                data-axis={guide.axis}
                style={
                  guide.axis === 'x'
                    ? {
                        transform: `translate(${guide.at}px, ${guide.from}px)`,
                        height: guide.to - guide.from,
                      }
                    : {
                        transform: `translate(${guide.from}px, ${guide.at}px)`,
                        width: guide.to - guide.from,
                      }
                }
              />
            ))}

          {interactive && attachTarget && (
            <div
              className="dc-attach-affordance"
              style={{ transform: `translate(${attachTarget.x}px, ${attachTarget.y - 30}px)` }}
            >
              Attach to {attachTarget.text || defaultTextFor(attachTarget.type)}
            </div>
          )}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}
