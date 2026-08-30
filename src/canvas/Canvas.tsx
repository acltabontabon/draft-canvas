import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type FinalConnectionState,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { defaultTextFor } from '../document/factory';
import { descendantsOf } from '../document/operations';
import type { DraftDocument, Side } from '../document/types';
import { anchorForDrop, isSide, rectOf, type Rect } from '../edges/routing';
import { useEditorStore } from '../store/editorStore';
import { pointer, useUiStore } from '../store/uiStore';
import { useThemeValue } from '../ui/theme/useTheme';
import { ATTACH_DWELL_MS, deepestBoundaryAt, evaluateAttachCandidates } from './dragTargets';
import { DraftEdgeView } from './DraftEdgeView';
import { DraftNodeView } from './DraftNodeView';
import { Markers } from './Markers';
import {
  EDGE_COMPONENT,
  NODE_COMPONENT,
  projectEdges,
  projectNodes,
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
  /** Called when the user asks for a new element at a point on the canvas. */
  onCreateAt?: (position: { x: number; y: number }) => void;
  /**
   * Called instead of creating a node when a connection is dragged onto empty
   * canvas — the caller opens a small type picker and creates+connects once
   * the user chooses, rather than guessing a type immediately.
   */
  onQuickConnectMenu?: (
    sourceId: string,
    sourceSide: Side | undefined,
    flowPosition: { x: number; y: number },
    screenPosition: { x: number; y: number },
  ) => void;
}

export function Canvas({ onCreateAt, onQuickConnectMenu }: CanvasProps) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const explainActive = useEditorStore((state) => state.flowPlayback.active);
  const focusActive = useEditorStore((state) => state.focus.active);
  const theme = useThemeValue();

  const store = useEditorStore;
  const { screenToFlowPosition, getNodes } = useReactFlow();

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
  /**
   * A marquee (rubber-band) drag drives edge selection through a second,
   * internal React Flow pathway that bypasses the controlled `edges` prop
   * entirely — unlike a plain click, which has no such pathway and relies on
   * `onEdgesChange`'s own `'select'` change as the only place that ever
   * happens. Applying that same change on top of the marquee's own pathway
   * is what raced (see `onEdgesChange`); only marquee gestures need to skip
   * it, so this ref (not e.g. a `useState`) tracks it without asking for a
   * render no one needs.
   */
  const marqueeActive = useRef(false);

  const clearDwell = useCallback(() => {
    if (dwellTimer.current !== null) {
      window.clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    dwellTargetId.current = null;
  }, []);

  const selectedNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);
  const selectedEdges = useMemo(() => new Set(selection.edges), [selection.edges]);

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
        if (draggedDoc) {
          const livePosition =
            posChange && posChange.type === 'position' && posChange.position
              ? posChange.position
              : { x: draggedDoc.x, y: draggedDoc.y };
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
          } else {
            clearDwell();
            useUiStore.getState().setAttachArmedTarget(null);
          }
        }
      } else {
        clearDwell();
        useUiStore.getState().setAttachArmedTarget(null);
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
    [clearDwell, getNodes, setNodes, store],
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
   */
  const onEdgesChange = useCallback(
    (changes: EdgeChange<DraftRfEdge>[]) => {
      const rest = marqueeActive.current
        ? changes.filter((change) => change.type !== 'select')
        : changes;
      if (rest.length === 0) return;
      setEdges((current) => applyEdgeChanges(rest, current));
    },
    [setEdges],
  );

  const onSelectionStart = useCallback(() => {
    marqueeActive.current = true;
  }, []);

  const onSelectionEnd = useCallback(() => {
    marqueeActive.current = false;
  }, []);

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodeList, edges: selectedEdgeList }: OnSelectionChangeParams) => {
      const next = {
        nodes: selectedNodeList.map((node) => node.id),
        edges: selectedEdgeList.map((edge) => edge.id),
      };
      const current = store.getState().selection;
      if (
        current.nodes.length === next.nodes.length &&
        current.edges.length === next.edges.length &&
        current.nodes.every((id, index) => next.nodes[index] === id) &&
        current.edges.every((id, index) => next.edges[index] === id)
      ) {
        return;
      }
      store.getState().setSelection(next);
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

    if (singleId && armedHost) {
      positions.delete(singleId);
      if (positions.size > 0) state.commitPositions(positions);
      state.attachExistingNode(singleId, armedHost);
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
  }, [clearDwell, getNodes, store]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // Handle ids are the side they sit on ('top'/'right'/'bottom'/'left'),
      // so this is the drag's actual start/end edge, not a guess — see
      // `EdgeAnchor` in `document/types.ts`.
      const sourceSide = isSide(connection.sourceHandle) ? connection.sourceHandle : undefined;
      const targetSide = isSide(connection.targetHandle) ? connection.targetHandle : undefined;
      store.getState().connect(connection.source, connection.target, sourceSide, targetSide);
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
      const sourceSide = isSide(connectionState.fromHandle?.id) ? connectionState.fromHandle.id : undefined;

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
          // attaches close to where the user actually dropped it; a drop near
          // dead centre keeps the dynamic side choice `chooseSides` would
          // pick anyway. See `anchorForDrop` in `edges/routing.ts`.
          const targetAnchor = anchorForDrop(rectOf(droppedOn), position);
          state.connect(source, droppedOn.id, sourceSide, targetAnchor?.side, undefined, targetAnchor?.offset);
        }
        return;
      }

      // Empty canvas: defer to the caller's Quick Connect picker rather than
      // guessing a type — the whole point is that the choice, not a guess,
      // decides what appears.
      onQuickConnectMenu?.(
        source,
        sourceSide,
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

  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!interactive) return;
      // React Flow has no `onPaneDoubleClick`, so this fires for the whole
      // canvas — including double-clicks on a node, which mean "edit this
      // label" and must not also drop a new card underneath it.
      const target = event.target as HTMLElement | null;
      if (!target?.classList.contains('react-flow__pane')) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      onCreateAt?.({ x: Math.round(position.x - 88), y: Math.round(position.y - 34) });
    },
    [interactive, onCreateAt, screenToFlowPosition],
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
    >
      <Markers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onDoubleClick={onPaneDoubleClick}
        onPaneClick={onPaneClick}
        onPointerMove={onPointerMove}
        onMoveEnd={onMoveEnd}
        defaultViewport={document.viewport}
        minZoom={0.1}
        maxZoom={4}
        // Every handle both starts and accepts a connection. Strict mode would
        // force the user to aim at the one handle designated as a target, which
        // is exactly the fiddling this tool exists to avoid.
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={interactive}
        nodesConnectable={interactive}
        elementsSelectable={interactive}
        panOnScroll
        selectionOnDrag={interactive}
        panOnDrag={interactive ? [1, 2] : true}
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
