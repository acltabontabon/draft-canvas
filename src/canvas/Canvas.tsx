import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useStoreApi,
  type Connection,
  type FinalConnectionState,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type XYPosition,
} from '@xyflow/react';
import { defaultTextFor, maxSizeFor, minSizeFor } from '../document/factory';
import { boundsOf, descendantsOf, hasAttachmentRoom } from '../document/operations';
import type { DraftDocument, DraftEdge, DraftNode, DraftViewport, Side } from '../document/types';
import { parseAnchorId, rectOf, snappedAnchorForDrop, type Rect } from '../edges/routing';
import { isEditableTarget } from '../lib/isEditableTarget';
import { motionMs } from '../lib/motion';
import { centerOf, clamp, pointInBox } from '../lib/math';
import { pathKey } from '../depth/tree';
import { lensFlow, useEditorStore } from '../store/editorStore';
import { edgeIndex, nodeIndex } from '../store/selectors';
import { pointer, useUiStore } from '../store/uiStore';
import { useThemeValue } from '../ui/theme/useTheme';
import { CanvasBackground } from './CanvasBackground';
import { ATTACH_DWELL_MS, evaluateAttachCandidates } from './dragTargets';
import {
  CAPSULE_MOVE_THRESHOLD_PX,
  CAPSULE_RELEASE_MARGIN_PX,
  EXPANDED,
  expandRect,
  nextCapsuleState,
  type CapsuleState,
} from './capsuleCollapse';
import { clearPathCache } from '../edges/nearest';
import { edgeLabelPoint, rectOfInternal, type InternalNode } from './edgeGeometry';
import { findEdgeDropCandidate } from './edgeDropTarget';
import { DraftEdgeView } from './DraftEdgeView';
import { EdgeLabelRoot } from './EdgeLabels';
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
import { computeSnap, sameGuides, type Guide } from './snapping';
import { snapResize } from './resizeSnap';
import { ContinuationGhost } from './ContinuationGhost';
import { RoomFrame } from './RoomFrame';
import { useContinuation } from './useContinuation';

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
/** How far (screen px) a dragged card moves before the connector under it is hit-tested again. */
const EDGE_PROBE_STEP_PX = 4;

/** The furthest the capsule leans toward an armed connector's landing point, in screen pixels.
 *  Small on purpose: this says "the drop has a destination", it does not drag the pointer. */
const CAPSULE_NUDGE_MAX_PX = 10;

/** Stable empty array, so `sameGuides` keeps short-circuiting rather than seeing a new `[]`. */
const NO_GUIDES: Guide[] = [];

/** Ties the capsule that was under the cursor to the chip it just became: the new chip plays the
 *  same one-shot arrival the accepted-continuation nodes do, and the marker expires on its own. */
/** The screen point a drag started from, whichever kind of event React Flow handed over. Null for
 *  a gesture that carried no pointer at all (a multi-touch start), where the aim point falls back
 *  to the card's own centre. */
function pointerOf(event: MouseEvent | TouchEvent): XYPosition | null {
  if ('touches' in event) {
    const touch = event.touches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

function markArrived(attachmentId: string | null): void {
  if (attachmentId) useUiStore.getState().setSettleNodeIds([attachmentId]);
}

/** Where a connector's attachment chip will actually appear — its label point, the same one
 *  `DraftEdgeView` hangs its chip row from, so the capsule's lean and the landing dot can never
 *  disagree about the destination. */
function landingPointFor(
  document: DraftDocument,
  edge: DraftEdge,
  internalNode: (id: string) => InternalNode | undefined,
): XYPosition | null {
  const source = internalNode(edge.source);
  const target = internalNode(edge.target);
  if (!source || !target) return null;
  const byId = nodeIndex(document.nodes);
  const sourceRect = rectOfInternal(source, byId.get(edge.source)?.type);
  const targetRect = rectOfInternal(target, byId.get(edge.target)?.type);
  if (!sourceRect || !targetRect) return null;
  // `interactionActive`: a drag is in flight, so route it the cheap way the live edge is being
  // routed right now — matching what is on screen matters more here than obstacle avoidance.
  return edgeLabelPoint(document, edge, sourceRect, targetRect, { interactionActive: true });
}

/** A capped step from `from` toward `to`, in screen pixels, rounded so sub-pixel drift never
 *  reaches the store. */
function leanToward(from: XYPosition, to: XYPosition | null, zoom: number): XYPosition {
  if (!to) return { x: 0, y: 0 };
  const dx = (to.x - from.x) * zoom;
  const dy = (to.y - from.y) * zoom;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { x: 0, y: 0 };
  const scale = Math.min(CAPSULE_NUDGE_MAX_PX, distance) / distance;
  return { x: Math.round(dx * scale), y: Math.round(dy * scale) };
}

/** See `onSelectionChange`: more reports than this inside the window is a feedback loop, not clicks. */
const SELECTION_BURST_WINDOW_MS = 300;
const SELECTION_BURST_LIMIT = 10;

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

/** A React Flow node by id — its live position and measured size mid-gesture. */
type NodeLookup = (id: string) => Pick<DraftRfNode, 'position' | 'width' | 'height' | 'measured'> | undefined;

/**
 * Nudges an in-flight drag onto alignment with its neighbours, and reports the
 * guides to draw. Returns the changes untouched when nothing is close enough.
 */
function snapChanges(
  changes: NodeChange<DraftRfNode>[],
  nodeById: NodeLookup,
  statics: readonly Rect[],
): { changes: NodeChange<DraftRfNode>[]; guides: Guide[] } {
  const moves = changes.filter(
    (change) => change.type === 'position' && change.dragging === true && change.position,
  );
  if (moves.length === 0 || statics.length === 0) return { ...NO_SNAP, changes };

  const rects: Rect[] = [];
  for (const change of moves) {
    if (change.type !== 'position' || !change.position) continue;
    const node = nodeById(change.id);
    rects.push({
      x: change.position.x,
      y: change.position.y,
      width: node?.width ?? node?.measured?.width ?? 0,
      height: node?.height ?? node?.measured?.height ?? 0,
    });
  }

  const bounds = boundsOf(rects);
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
 * The resize counterpart to `snapChanges` — see `snapResize` for which edges snap. The rect the node
 * started the gesture with is the document's: nothing is written to it until the gesture ends.
 *
 * The terminal frame (`resizing: false`) isn't snapped again: React Flow reports its own raw,
 * unsnapped size there, so it's replaced with the rect the last live frame actually showed —
 * otherwise the far edge of a snapped top/left resize would commit off by the snap.
 */
function snapResizeChanges(
  changes: NodeChange<DraftRfNode>[],
  nodeById: NodeLookup,
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
  if (resizing.length === 0) return { ...NO_SNAP, changes };

  let result = changes;
  const guides: Guide[] = [];
  const documentNodes = nodeIndex(useEditorStore.getState().document.nodes);

  for (const change of resizing) {
    if (change.type !== 'dimensions' || !change.dimensions) continue;
    const live = nodeById(change.id);
    const node = documentNodes.get(change.id);
    if (!live || !node) continue;

    if (change.resizing === false) {
      const width = live.width ?? live.measured?.width;
      const height = live.height ?? live.measured?.height;
      if (width === undefined || height === undefined) continue;
      result = result.map((c) => (c === change ? { ...change, dimensions: { width, height } } : c));
      continue;
    }

    // A proportional resize (a Junction stays round) would need both axes snapped together.
    if (statics.length === 0 || node.type === 'ellipse') continue;
    const posChange = changes.find((c) => c.type === 'position' && c.id === change.id && c.position);
    const position = (posChange?.type === 'position' ? posChange.position : undefined) ?? live.position;
    const min = minSizeFor(node.type);
    const snap = snapResize(
      { x: node.x, y: node.y, width: node.width, height: node.height },
      { ...position, width: change.dimensions.width, height: change.dimensions.height },
      statics,
      { min, max: maxSizeFor(node.type) ?? { width: Infinity, height: Infinity } },
    );
    guides.push(...snap.guides);
    if (snap.guides.length === 0) continue;

    const { x, y, width, height } = snap.rect;
    result = result.map((c) => {
      if (c === change) return { ...change, dimensions: { width, height } };
      if (c === posChange) return { ...posChange, position: { x, y } };
      return c;
    });
    // A top or left edge that snapped moves the node even on a frame React Flow sent no position for.
    if (!posChange && (x !== position.x || y !== position.y)) {
      result = [...result, { type: 'position', id: change.id, position: { x, y } }];
    }
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
  const byId = nodeIndex(doc.nodes);
  const liveGroups = new Map<string, DraftRfNode>();
  for (const node of nodes) if (swept.has(node.id)) liveGroups.set(node.id, node);
  const patches = new Map<string, { x: number; y: number }>();

  for (const [groupId, descendantIds] of swept) {
    const liveGroup = liveGroups.get(groupId);
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

/** How long the zoom must hold still before `--dc-zoom` follows it. */
const ZOOM_VARIABLE_SETTLE_MS = 140;

/** A host's name in the one-line "Attach to …" pill — a note can hold pages of text, and the pill
 *  never wraps, so anything past a short name would run off across the canvas. */
/**
 * Publishes the zoom as `--dc-zoom` on React Flow's root, for the few hit areas that must stay a
 * steady size on screen (`canvas.css`). Written from a store subscription — no React render per
 * zoom frame — in 5% steps, and only once the zoom has stopped moving.
 *
 * Every write restyles the whole canvas subtree (a custom property is inherited by every one of its
 * thousands of elements), which on a large diagram was 30–90 ms and happened on every step of a wheel
 * or pinch zoom — the hitches in an otherwise cheap gesture. What reads the value is hit-area sizing,
 * which nobody is exercising while the view is still moving, so it follows the zoom when it settles.
 * The first value is written at once: there is no earlier one to be stale against.
 */
function useZoomVariable() {
  const storeApi = useStoreApi();
  useEffect(() => {
    let written: { node: HTMLElement; zoom: number } | null = null;
    let timer: number | undefined;
    const quantized = (transform: [number, number, number]) => Math.round(transform[2] * 20) / 20;
    const write = () => {
      timer = undefined;
      const { domNode, transform } = storeApi.getState();
      const zoom = quantized(transform);
      if (!domNode || (written?.node === domNode && written.zoom === zoom)) return;
      domNode.style.setProperty('--dc-zoom', String(zoom));
      written = { node: domNode, zoom };
    };
    write();
    const unsubscribe = storeApi.subscribe(({ domNode, transform }) => {
      if (written === null) {
        write();
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      // Back to the value already published: nothing to follow, so nothing is scheduled.
      timer = written.node === domNode && written.zoom === quantized(transform) ? undefined : window.setTimeout(write, ZOOM_VARIABLE_SETTLE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [storeApi]);
}

/**
 * Whether a room's camera is one somebody actually chose.
 *
 * A room is made by the first shape drawn in it, or arrives whole from a starter or a paste, and
 * none of those is anyone framing a view — so a room can perfectly well carry a camera pointing
 * somewhere else entirely. Restoring that faithfully is worse than useless: you asked to look
 * inside a shape and got an empty corner of it. A camera still exactly where every room's starts
 * has never been moved, so there is nothing to restore and the room is framed instead.
 */
function hasACameraOfItsOwn(room: DraftDocument): boolean {
  const { x, y, zoom } = room.viewport;
  return x !== 0 || y !== 0 || zoom !== 1;
}

/** Breathing room around a room that is being framed on arrival, in screen pixels. */
const FRAME_PAD = 72;

/**
 * The camera that puts a whole room on screen.
 *
 * Worked out from the document rather than asked of React Flow, because `fitView` measures what
 * is currently rendered and arriving somewhere means the shapes it would measure are the ones
 * being replaced. This also makes the landing exactly the same with the animation and without it,
 * which is what reduced motion has to be able to promise.
 */
function frameFor(room: DraftDocument, width: number, height: number): DraftViewport | null {
  const bounds = boundsOf(room.nodes);
  if (!bounds || width <= 0 || height <= 0) return null;
  const zoom = clamp(
    Math.min(
      (width - FRAME_PAD * 2) / Math.max(bounds.width, 1),
      (height - FRAME_PAD * 2) / Math.max(bounds.height, 1),
    ),
    MIN_FRAME_ZOOM,
    1,
  );
  return {
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

/** Far enough out for a big room, never so far that its labels stop being readable. */
const MIN_FRAME_ZOOM = 0.25;

function truncateForAffordance(text: string): string {
  const firstLine = text.split('\n', 1)[0]!.trim();
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine;
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
    center: { x: number; y: number },
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

const CanvasBody = memo(function CanvasBody({ onCreateAt, onQuickConnectMenu, onEmptyCanvasMenu }: CanvasProps) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const explainActive = useEditorStore((state) => state.flowPlayback.active);
  const focusActive = useEditorStore((state) => state.focus.active);
  // A flow merely selected (not presented) acts as a gentler lens — see
  // `docs/reference/architecture.md`'s "Flows and presentation". `lensFlow` owns the rule for when that
  // lens is on (never during Presentation/Focus, never for an empty flow).
  const lensActive = useEditorStore((state) => lensFlow(state) !== undefined);
  const theme = useThemeValue();
  // A fresh object here would defeat React Flow's own memoized renderer on every drag frame.
  const connectionLineStyle = useMemo(() => ({ stroke: theme.selection, strokeWidth: 1.8 }), [theme.selection]);

  const { screenToFlowPosition, flowToScreenPosition, getNodes, getInternalNode, getZoom, setViewport, fitView } =
    useReactFlow<DraftRfNode>();

  // `defaultViewport` is read once, at mount — so stepping into or out of a shape has to move the
  // camera itself. Each room remembers where it was left; one that has never been drawn in has no
  // camera of its own, and is framed rather than left wherever the last room happened to be.
  //
  // Which room this *was* is remembered by value, not by a "first run" flag: React runs effects
  // twice on mount in development, and a flag would spend itself on the first run and then move
  // the camera on the second — for a move that never happened.
  const path = useEditorStore((state) => state.path);
  const shownPath = useRef<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = pathKey(path);
    if (shownPath.current === key) return;
    const first = shownPath.current === null;
    shownPath.current = key;
    if (first) return;
    const state = useEditorStore.getState();
    const duration = motionMs(320);
    // Arriving somewhere should show what is there. A room nobody has panned about in carries
    // whatever camera it was made with — a starter's rooms all start at the origin — and
    // restoring that put the user off the side of the architecture they had just asked to see.
    if (hasACameraOfItsOwn(state.document)) {
      void setViewport(state.document.viewport, { duration });
      return;
    }
    const pane = paneRef.current?.getBoundingClientRect();
    const framed = pane ? frameFor(state.document, pane.width, pane.height) : null;
    if (framed) void setViewport(framed, { duration });
    else void fitView({ padding: 0.4, duration, maxZoom: 1 });
  }, [path, fitView, setViewport]);

  const interactive = mode === 'edit';
  useContinuation(interactive);

  useZoomVariable();

  const [guides, setGuides] = useState<Guide[]>([]);
  const attachArmedTarget = useUiStore((state) => state.attachArmedTarget);
  const attachTarget = attachArmedTarget ? nodeIndex(document.nodes).get(attachArmedTarget) : undefined;
  /** A boolean, not the capsule itself: this only widens the connector hit corridor for the
   *  length of the gesture, so it flips twice per drag and never re-renders on the nudge. */
  const carryingCapsule = useUiStore((state) => state.dragCapsule !== null);

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
   * React Flow skips `onNodeDragStop` for a drag it aborts: a second touch landing mid-drag, or the
   * node under the pointer vanishing. The gesture's undo bracket and `interactionActive` would then
   * stay open, and every later edit would skip history until some other drag closed them. So the
   * drag finishes itself on exactly those two conditions — React Flow's own — rather than on a
   * release, which its drag handler swallows (`stopImmediatePropagation` on `mouseup`).
   */
  const grabbedId = useRef<string | null>(null);
  const stopWatchingTouches = useRef<(() => void) | null>(null);
  const finishDrag = useRef<() => void>(() => {});
  /** Same indirection as `finishDrag` above, for the Escape listener a drag installs: the listener
   *  is bound once at drag start, but the callback it should reach is rebuilt on every render. */
  const cancelDrag = useRef<() => void>(() => {});
  /**
   * Attach-arming dwell: while the pointer sits still, React Flow fires no
   * further drag events at all, so elapsed time can't be checked from inside
   * `onNodesChange` — it must be a real timer, armed independently once a
   * frame reports the dragged node's centre sitting over a candidate.
   */
  const dwellTimer = useRef<number | null>(null);
  const dwellTargetId = useRef<string | null>(null);
  /** The screen point the last connector hit-test ran at, while a note/code card is over no node.
   *  `elementsFromPoint` forces a layout, so it isn't repeated until the card has moved a few
   *  pixels; null whenever the previous frame took any other branch, so re-entry always probes. */
  const lastEdgeProbe = useRef<{ screen: XYPosition; flow: XYPosition } | null>(null);
  /** Where the right mouse button went down, in screen coordinates — compared against the native
   *  `contextmenu` event's own position to tell a stationary right-click from a right-drag. */
  const rightPointerDown = useRef<{ x: number; y: number } | null>(null);
  /**
   * The aim point of a note/code drag: where on the card the grab landed, in flow units from its
   * own top-left. Recorded once, then added to the card's live position every frame — the card
   * moves by the pointer delta, so this tracks the pointer exactly without a pointer listener of
   * its own, and stays correct through zoom, pan and auto-pan for free.
   *
   * It is what the card is aimed *with*: attach targets are tested against this point rather than
   * against the card's (now unpainted) rectangle, so what arms is always whatever the capsule is
   * sitting on. See `dragCapsule.ts`.
   */
  const grabOffset = useRef<XYPosition | null>(null);
  /** The card's position when the grab started — the baseline for the movement threshold that
   *  keeps a card resting on a shape from collapsing the instant it is touched. */
  const grabOrigin = useRef<XYPosition | null>(null);
  const capsule = useRef<CapsuleState>(EXPANDED);
  /** The capsule's lean toward an armed connector's landing point, in screen pixels. Recomputed
   *  only on the throttled edge probe, never per frame. */
  const nudge = useRef<XYPosition>({ x: 0, y: 0 });
  /** The rect of whatever caused the current collapse, for the release margin to measure against —
   *  one rect test per frame instead of a second pass over every candidate. */
  const capsuleHostRect = useRef<Rect | null>(null);
  /**
   * Escape during a drag. React Flow has no cancel of its own and keeps streaming position
   * changes until the pointer is released, so cancelling is two halves: this flag makes
   * `onNodesChange` drop those changes (which is what actually pins the card), and makes
   * `onNodeDragStop` skip the commit entirely. Nothing was written to the document mid-gesture,
   * so `endInteraction` finds it unchanged and records no history entry.
   */
  const dragCancelled = useRef(false);
  const stopWatchingEscape = useRef<(() => void) | null>(null);
  /**
   * Escape while a new connector is being dragged out. Same shape as `dragCancelled`, for the same
   * reason: React Flow has no cancel of its own and completes the connection on release wherever it
   * lands, so cancelling is vetoing that (`onConnect` and `onConnectEnd` both check this) and
   * hiding the live line, which React Flow would otherwise keep redrawing on every move.
   */
  const connectCancelled = useRef(false);
  const stopWatchingConnect = useRef<(() => void) | null>(null);
  const [connectionCancelled, setConnectionCancelled] = useState(false);
  const rfStore = useStoreApi();
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

  /** Puts the dragged card back on screen and forgets everything the capsule was tracking. Called
   *  from every way a gesture can end — a drop, Escape, an abort, unmount. */
  const clearCapsule = useCallback(() => {
    capsule.current = EXPANDED;
    capsuleHostRect.current = null;
    nudge.current = { x: 0, y: 0 };
    grabOffset.current = null;
    grabOrigin.current = null;
    clearPathCache();
    useUiStore.getState().setDragCapsule(null);
  }, []);
  useEffect(() => clearCapsule, [clearCapsule]);

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
    // `projectNodes`/`projectEdges` only ever read `document.nodes`/`document.edges`, so a
    // metadata-only document swap (e.g. adopting a cross-tab rename mid-drag) must not retrigger
    // this — it would rebuild every node/edge from their last-committed geometry, snapping a live
    // drag back to its pre-gesture position for a frame even though nothing it renders changed.
    view.from.document.nodes !== document.nodes ||
    view.from.document.edges !== document.edges ||
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
      // A cancelled drag (Escape) still receives frames until the pointer is released — React
      // Flow has no cancel of its own. Dropping their position changes is what pins the card
      // where `onDragCancel` put it back; everything else (a dimensions change, a selection
      // change) still applies normally.
      if (dragCancelled.current && draggingIds.current.size > 0) {
        const moving = draggingIds.current;
        changes = changes.filter((change) => !(change.type === 'position' && moving.has(change.id)));
        if (changes.length === 0) return;
      }
      // Per id, not `getNodes()`: that copies every node on every frame of a drag.
      const nodeById: NodeLookup = (id) => getInternalNode(id);
      const snappedMove = snapChanges(changes, nodeById, staticRects.current);

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
        resizeStaticRects.current = useEditorStore
          .getState()
          .document.nodes.filter((node) => node.id !== dimChange.id)
          .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
      }
      const snapped = snapResizeChanges(snappedMove.changes, nodeById, resizeStaticRects.current);
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
      let probingEdges = false;
      // Whether this frame leaves the dragged card collapsed into its capsule. Decided from the
      // same aim point that decides arming, so the capsule is never sitting on one thing while
      // something else is armed.
      let capsuleInside = false;
      /** The dragged card and where it is aimed, when this frame could collapse it at all. */
      let capsuleSubject: { node: DraftNode; aim: XYPosition } | null = null;
      if (!dragCancelled.current && draggingIds.current.size === 1 && sweptDescendants.current.size === 0) {
        const [draggedId] = draggingIds.current;
        const state = useEditorStore.getState();
        const draggedDoc = nodeIndex(state.document.nodes).get(draggedId!);
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
        // A card that itself carries attachments can't become one — an attachment has no
        // attachments of its own, so folding it in would silently drop them. It just moves.
        if (draggedDoc?.attachments?.length) {
          clearDwell();
          useUiStore.getState().setAttachArmedTarget(null);
          useUiStore.getState().setAttachArmedEdgeTarget(null);
        } else if (draggedDoc && livePosition) {
          const liveRect: Rect = { ...livePosition, width: draggedDoc.width, height: draggedDoc.height };
          const collapsible = draggedDoc.type === 'note' || draggedDoc.type === 'code';
          // The point the card is aimed with. Falls back to its centre before a grab offset is
          // known (a drag started some way that carried no pointer event), which is what this
          // always used.
          const offset = grabOffset.current;
          const aim =
            collapsible && offset
              ? { x: livePosition.x + offset.x, y: livePosition.y + offset.y }
              : centerOf(liveRect);
          // A Note/Code card is tested as a point, not as its rectangle: its rectangle is not on
          // screen while the capsule stands in for it, so arming off it would highlight targets
          // nowhere near what the user is pointing at. A zero-size rect runs the *existing*
          // evaluation unchanged and yields exactly the semantics this wants — no overlap winner
          // (`overlapArea` is 0), so every shape arms through the deliberate dwell instead.
          const probeRect: Rect = collapsible ? { x: aim.x, y: aim.y, width: 0, height: 0 } : liveRect;
          // Only past a real movement threshold. Grabbing a note that already rests on a shape
          // would otherwise collapse it before the pointer had moved at all — the card would
          // simply vanish on mousedown.
          const origin = grabOrigin.current;
          const movedFar =
            origin !== null &&
            Math.hypot(livePosition.x - origin.x, livePosition.y - origin.y) * getZoom() >=
              CAPSULE_MOVE_THRESHOLD_PX;
          if (collapsible && offset && movedFar) capsuleSubject = { node: draggedDoc, aim };
          // Only a boundary has descendants, so only a boundary pays for walking them.
          const exclude = new Set(
            draggedDoc.type === 'group' ? [draggedDoc.id, ...descendantsOf(state.document, draggedDoc.id)] : [draggedDoc.id],
          );
          const { overlapId, centerHitId } = evaluateAttachCandidates(
            probeRect,
            draggedDoc.type,
            state.document,
            exclude,
          );

          if (overlapId) {
            clearDwell();
            useUiStore.getState().setAttachArmedTarget(overlapId);
            useUiStore.getState().setAttachArmedEdgeTarget(null);
          } else if (centerHitId) {
            capsuleInside = true;
            const host = nodeIndex(state.document.nodes).get(centerHitId);
            if (host) capsuleHostRect.current = { x: host.x, y: host.y, width: host.width, height: host.height };
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
            probingEdges = true;
            const flowPoint = aim;
            const screenPoint = flowToScreenPosition(flowPoint);
            const lastProbe = lastEdgeProbe.current;
            // Flow space too: an auto-pan near the viewport edge slides connectors under a card
            // whose screen position hasn't changed.
            if (
              !lastProbe ||
              Math.hypot(screenPoint.x - lastProbe.screen.x, screenPoint.y - lastProbe.screen.y) >= EDGE_PROBE_STEP_PX ||
              Math.hypot(flowPoint.x - lastProbe.flow.x, flowPoint.y - lastProbe.flow.y) >= EDGE_PROBE_STEP_PX
            ) {
              lastEdgeProbe.current = { screen: screenPoint, flow: flowPoint };
              const edgeId = findEdgeDropCandidate(screenPoint.x, screenPoint.y, draggedDoc.id, flowPoint);
              const edge = edgeId ? edgeIndex(state.document.edges).get(edgeId) : undefined;
              // The card's own connectors never arm: attaching removes the card, and them with it.
              const canAttach =
                edge !== undefined &&
                edge.source !== draggedDoc.id &&
                edge.target !== draggedDoc.id &&
                hasAttachmentRoom(edge, 'edge');
              useUiStore.getState().setAttachArmedEdgeTarget(canAttach ? edge.id : null);
              // A connector has no rect to hold a release margin against, so the corridor itself
              // is the margin — already generously widened for the length of this gesture (see
              // `.dc-canvas[data-attach-drag]`), and the minimum hold covers a fast crossing.
              if (canAttach) capsuleHostRect.current = null;
              // The capsule leans toward the exact spot the chip will appear — the connector's
              // own label point, the same one `DraftEdgeView` hangs its chip row from, so the
              // lean and the landing dot always agree. Capped hard: this is a hint that the drop
              // has a destination, not a real magnet that would fight the pointer.
              nudge.current = canAttach && edge ? leanToward(flowPoint, landingPointFor(state.document, edge, getInternalNode), getZoom()) : { x: 0, y: 0 };
            }
            capsuleInside = useUiStore.getState().attachArmedEdgeTarget !== null;
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
      if (!probingEdges) lastEdgeProbe.current = null;

      // Collapse/expand, decided from the same aim point that decided arming above. This is pure
      // paint — the card itself never moves or resizes — so neither direction can make it jump,
      // and a drop that attaches nothing lands exactly where it always did.
      if (capsuleSubject) {
        const { node: subject, aim } = capsuleSubject;
        const margin = CAPSULE_RELEASE_MARGIN_PX / Math.max(getZoom(), 0.01);
        const host = capsuleHostRect.current;
        const near = host !== null && pointInBox(aim, expandRect(host, margin));
        const next = nextCapsuleState(capsule.current, { inside: capsuleInside, near }, performance.now());
        if (next !== capsule.current) {
          capsule.current = next;
          if (!next.collapsed) capsuleHostRect.current = null;
        }
        const offset = grabOffset.current;
        useUiStore
          .getState()
          .setDragCapsule(
            next.collapsed && offset
              ? { nodeId: subject.id, offsetX: offset.x, offsetY: offset.y, nudgeX: nudge.current.x, nudgeY: nudge.current.y }
              : null,
          );
      } else if (capsule.current.collapsed) {
        capsule.current = EXPANDED;
        capsuleHostRect.current = null;
        useUiStore.getState().setDragCapsule(null);
      }

      setNodes((current) => {
        const next = applyNodeChanges(snapped.changes, current);
        return sweepDescendants(next, sweptDescendants.current, useEditorStore.getState().document);
      });

      // Guides appear and disappear; they do not move every frame. Updating
      // state only when the set actually changes is what keeps drags smooth.
      //
      // Read *after* the capsule decision above, never before it: alignment guides are measured
      // against the dragged card's own edges, so while the capsule stands in for it they would be
      // lining up a box nobody can see. Checking the flag earlier leaves the guide from the last
      // pre-collapse frame stranded on screen for the rest of the gesture.
      const shown = capsule.current.collapsed ? NO_GUIDES : guides;
      setGuides((current) => (sameGuides(current, shown) ? current : shown));

      // Committing from `snapped.changes` (not the raw `changes` argument) is
      // what makes the terminal frame's snap correction actually stick — the
      // raw terminal change still carries React Flow's own unsnapped size.
      for (const change of snapped.changes) {
        if (change.type === 'dimensions' && change.resizing === false) {
          const resized = change.dimensions;
          if (resized) {
            // A top/left handle moves the node as well as sizing it, but React Flow's terminal
            // frame carries only dimensions — the position only ever streamed into the view. The
            // last live position has to be committed alongside the size, or projection snaps the
            // node back to its pre-resize x/y and it appears to have grown the other way.
            const posChange = snapped.changes.find(
              (c) => c.type === 'position' && c.id === change.id && c.position,
            );
            const position =
              (posChange?.type === 'position' ? posChange.position : undefined) ??
              nodeById(change.id)?.position;
            useEditorStore.getState().updateNodeById(
              change.id,
              {
                ...(position ? { x: position.x, y: position.y } : {}),
                width: resized.width,
                height: resized.height,
              },
              'Resize',
            );
          }
        }
      }
    },
    [clearDwell, flowToScreenPosition, getInternalNode, getZoom, setNodes],
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
      const baseline = pendingSelectionRef.current ?? useEditorStore.getState().selection;
      // See `resolveSelectedEdgeIds`'s own doc comment (`projection.ts`) for why this can't
      // just trust React Flow's reported `selectedEdgeList` unconditionally.
      const edgeIds = resolveSelectedEdgeIds(
        nodeIds,
        baseline.nodes,
        selectedEdgeList.map((edge) => edge.id),
        useEditorStore.getState().document.edges,
      );
      const next = { nodes: nodeIds, edges: edgeIds };
      if (sameSelection(baseline, next)) return;

      const now = performance.now();
      const burst = selectionBurst.current;
      if (now > burst.windowEndsAt) burst.count = 0;
      burst.count += 1;
      burst.windowEndsAt = now + SELECTION_BURST_WINDOW_MS;

      if (burst.count <= SELECTION_BURST_LIMIT) {
        useEditorStore.getState().setSelection(next);
        return;
      }
      pendingSelectionRef.current = next;
      if (selectionFrameRef.current === null) {
        selectionFrameRef.current = requestAnimationFrame(() => {
          selectionFrameRef.current = null;
          const pending = pendingSelectionRef.current;
          pendingSelectionRef.current = null;
          if (pending) useEditorStore.getState().setSelection(pending);
        });
      }
    },
    [],
  );

  /**
   * React Flow reports exactly which nodes the gesture is moving — the whole
   * selection when the grab started on a selected node, otherwise just the one
   * under the cursor. Deriving it from our own selection instead would commit
   * the wrong node's position whenever those two disagree.
   */
  const onNodeDragStart = useCallback(
    (event: MouseEvent | TouchEvent, grabbed: DraftRfNode, dragged: DraftRfNode[]) => {
      const state = useEditorStore.getState();
      state.beginInteraction('Move');

      grabbedId.current = grabbed.id;
      dragCancelled.current = false;
      // Where on the card the grab landed. Recorded once here rather than tracked with a pointer
      // listener: React Flow moves the card by the pointer delta, so the card's live position plus
      // this offset *is* the pointer, in flow space, on every later frame.
      const grabPoint = pointerOf(event);
      const grabFlow = grabPoint ? screenToFlowPosition(grabPoint) : null;
      grabOffset.current = grabFlow
        ? { x: grabFlow.x - grabbed.position.x, y: grabFlow.y - grabbed.position.y }
        : null;
      grabOrigin.current = { x: grabbed.position.x, y: grabbed.position.y };
      capsule.current = EXPANDED;
      capsuleHostRect.current = null;
      nudge.current = { x: 0, y: 0 };

      // Escape cancels the drag. React Flow has none of its own, and `EditorScreen`'s global
      // Escape is gated on `interactionActive`, so nothing else is listening while this runs.
      stopWatchingEscape.current?.();
      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== 'Escape' || draggingIds.current.size === 0 || dragCancelled.current) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        cancelDrag.current();
      };
      // The window losing focus mid-drag (Cmd-Tab, a system dialog) is the one way a button release
      // can go to somebody else's window, leaving the drag half-finished with nobody holding the
      // pointer. What the person meant is unknowable, so the only safe reading is the cancel one —
      // never a commit of wherever the card happened to be.
      const onBlur = () => {
        if (draggingIds.current.size === 0 || dragCancelled.current) return;
        cancelDrag.current();
      };
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('blur', onBlur);
      stopWatchingEscape.current = () => {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('blur', onBlur);
        stopWatchingEscape.current = null;
      };

      stopWatchingTouches.current?.();
      const onTouchMove = (event: TouchEvent) => {
        if (event.touches.length > 1 && draggingIds.current.size > 0) finishDrag.current();
      };
      window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
      stopWatchingTouches.current = () => {
        window.removeEventListener('touchmove', onTouchMove, { capture: true });
        stopWatchingTouches.current = null;
      };

      const moving = new Set(dragged.map((node) => node.id));
      draggingIds.current = moving;

      const swept = new Map<string, string[]>();
      const byId = nodeIndex(state.document.nodes);
      for (const node of dragged) {
        const doc = byId.get(node.id);
        if (doc?.type !== 'group') continue;
        const descendants = descendantsOf(state.document, doc.id).filter((id) => !moving.has(id));
        if (descendants.length > 0) {
          swept.set(doc.id, descendants);
          for (const id of descendants) moving.add(id);
        }
      }
      sweptDescendants.current = swept;
      useUiStore.getState().setInteractionActive(true, moving);
      clearDwell();
      useUiStore.getState().setAttachArmedTarget(null);
      useUiStore.getState().setAttachArmedEdgeTarget(null);

      staticRects.current = state.document.nodes
        .filter((node) => !moving.has(node.id))
        .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
    },
    [clearDwell, screenToFlowPosition],
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
   * simply a move. Attach is deliberately restricted to a single, unambiguous
   * node, but membership (2) is not: `reconcileMembership` applies the same
   * centre rule to every shape a multi-selection or a swept boundary moved,
   * because a shape that leaves its boundary while keeping its `parentId` is
   * deleted along with it.
   */
  /**
   * Escape mid-drag. The card goes back where it started and nothing is committed — no move, no
   * attach, no reparent, and no history entry, since the document was never written during the
   * gesture in the first place. React Flow keeps streaming position changes until the pointer is
   * released; `onNodesChange` drops them from here on, which is what actually pins the card.
   */
  const onDragCancel = useCallback(() => {
    dragCancelled.current = true;
    clearDwell();
    clearCapsule();
    setGuides([]);
    useUiStore.getState().setAttachArmedTarget(null);
    useUiStore.getState().setAttachArmedEdgeTarget(null);
    // Back to the committed positions. The document is the pre-drag truth, so there is nothing
    // extra to have remembered.
    const byId = nodeIndex(useEditorStore.getState().document.nodes);
    const moving = draggingIds.current;
    setNodes((current) =>
      current.map((node) => {
        if (!moving.has(node.id)) return node;
        const doc = byId.get(node.id);
        if (!doc || (node.position.x === doc.x && node.position.y === doc.y)) return node;
        return { ...node, position: { x: doc.x, y: doc.y }, dragging: false };
      }),
    );
  }, [clearCapsule, clearDwell, setNodes]);
  useEffect(() => {
    cancelDrag.current = onDragCancel;
  }, [onDragCancel]);

  const onNodeDragStop = useCallback(() => {
    stopWatchingTouches.current?.();
    stopWatchingEscape.current?.();
    grabbedId.current = null;
    setGuides([]);
    // A cancelled gesture commits nothing at all. `endInteraction` still runs below to close the
    // bracket, and is a guaranteed no-op: it bails when the document is unchanged, which it is.
    if (dragCancelled.current) {
      dragCancelled.current = false;
      useEditorStore.getState().endInteraction();
      useUiStore.getState().setInteractionActive(false);
      draggingIds.current = new Set();
      lastEdgeProbe.current = null;
      sweptDescendants.current = new Map();
      clearDwell();
      clearCapsule();
      useUiStore.getState().setAttachArmedTarget(null);
      useUiStore.getState().setAttachArmedEdgeTarget(null);
      return;
    }
    const state = useEditorStore.getState();
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
      markArrived(state.attachExistingNode(singleId, armedHost));
    } else if (singleId && armedEdge) {
      positions.delete(singleId);
      if (positions.size > 0) state.commitPositions(positions);
      markArrived(state.attachExistingNodeToEdge(singleId, armedEdge));
    } else {
      // Membership follows where things landed, for a whole selection or a boundary and what it
      // carries as much as for one shape dropped on its own. `parentId` is what a delete cascades
      // along, so a shape carried out of its boundary but still parented to it would go with it.
      // Written together with the move: each write re-derives every connector's route and crossings.
      state.commitMove(positions, draggedIds);
    }

    state.endInteraction(singleId && (armedHost || armedEdge) ? 'Attach' : undefined);
    useUiStore.getState().setInteractionActive(false);
    draggingIds.current = new Set();
    lastEdgeProbe.current = null;
    sweptDescendants.current = new Map();
    clearDwell();
    clearCapsule();
    useUiStore.getState().setAttachArmedTarget(null);
    useUiStore.getState().setAttachArmedEdgeTarget(null);
  }, [clearCapsule, clearDwell, getNodes]);

  useEffect(() => {
    finishDrag.current = onNodeDragStop;
  }, [onNodeDragStop]);
  useEffect(() => () => stopWatchingTouches.current?.(), []);
  useEffect(() => () => stopWatchingEscape.current?.(), []);
  // The grabbed node gone from the document mid-drag (deleted some way other than a key, which
  // waits for the drag): React Flow abandons the gesture on its next move.
  useEffect(() => {
    const id = grabbedId.current;
    if (id && draggingIds.current.size > 0 && !nodeIndex(document.nodes).has(id)) finishDrag.current();
  }, [document.nodes]);

  const onConnectStart = useCallback(() => {
    connectCancelled.current = false;
    stopWatchingConnect.current?.();
    // Capture phase, and stopped: the editor's own Escape (deselect, or step back out of a room) is
    // gated on `interactionActive`, which a connection drag does not set, so without this one press
    // would cancel nothing and also clear the selection the drag started from.
    const cancel = () => {
      connectCancelled.current = true;
      setConnectionCancelled(true);
      rfStore.getState().cancelConnection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || connectCancelled.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    // Losing the window mid-drag reads as a cancel for the same reason it does for a shape.
    const onBlur = () => {
      if (!connectCancelled.current) cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    stopWatchingConnect.current = () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      stopWatchingConnect.current = null;
    };
  }, [rfStore]);
  useEffect(() => () => stopWatchingConnect.current?.(), []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connectCancelled.current) return;
      if (!connection.source || !connection.target) return;
      // A handle id encodes exactly which of the 12 anchors it is (see
      // `HANDLE_ANCHORS`/`parseAnchorId` in `edges/routing.ts`), so this is
      // the drag's actual start/end point, not a guess — see `EdgeAnchor` in
      // `document/types.ts`.
      const sourceAnchor = parseAnchorId(connection.sourceHandle);
      const targetAnchor = parseAnchorId(connection.targetHandle);
      useEditorStore
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
    [],
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
      stopWatchingConnect.current?.();
      if (connectCancelled.current) {
        // Released after Escape: nothing connects, and nothing is offered in place of it.
        connectCancelled.current = false;
        setConnectionCancelled(false);
        return;
      }
      if (connectionState.isValid) return;
      const source = connectionState.fromNode?.id;
      if (!source) return;
      const sourceAnchor = parseAnchorId(connectionState.fromHandle?.id);

      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      const state = useEditorStore.getState();

      // React Flow only reports `toNode` when the pointer is within the
      // connection radius of a handle, so anywhere else on a node counts as a
      // miss. Hit-testing the drop point against node rectangles ourselves is
      // what makes "drag onto that box" work the way people expect.
      const droppedOn = [...state.document.nodes]
        .filter((node) => node.type !== 'group')
        .sort((a, b) => b.z - a.z)
        .find((node) => pointInBox(position, node));

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
        position,
      );
    },
    [onQuickConnectMenu, screenToFlowPosition],
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
   * `onNodeContextMenu`/`onEdgeContextMenu` instead of a fresh `useEditorStore.getState().selection`, because
   * by the time those fire, React Flow's own default click-to-select handling (on the node/edge's
   * own wrapper, a descendant of this div) has already run and collapsed the selection to just the
   * clicked element — confirmed empirically, not assumed. Capturing here, on `onPointerDownCapture`
   * (the capture phase always reaches an ancestor before any bubble-phase handler on a descendant
   * runs, regardless of DOM position), is what gets ahead of that collapse.
   */
  const selectionAtRightPointerDown = useRef<{ nodes: string[]; edges: string[] } | null>(null);

  const onCanvasPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Any other press clears the snapshot: a touch/pen long-press opens a context menu with
      // `button === 0`, and must not be measured against (or restore the selection of) some
      // earlier, unrelated right-click.
      if (event.button !== 2) {
        rightPointerDown.current = null;
        selectionAtRightPointerDown.current = null;
        return;
      }
      rightPointerDown.current = { x: event.clientX, y: event.clientY };
      selectionAtRightPointerDown.current = useEditorStore.getState().selection;
    },
    [],
  );

  /** True once the pointer has moved past `CONTEXT_MENU_DRAG_THRESHOLD_PX` since the right button
   *  went down — a real gesture (jitter aside), not a click, so no menu should open for it. */
  const movedPastContextMenuThreshold = useCallback((event: { clientX: number; clientY: number }) => {
    const down = rightPointerDown.current;
    if (!down) return false;
    return Math.hypot(event.clientX - down.x, event.clientY - down.y) > CONTEXT_MENU_DRAG_THRESHOLD_PX;
  }, []);

  /** Each right press is consumed by exactly one context menu: left in place, a later Shift+F10 /
   *  Menu-key menu (no pointer press in between) would be measured against — and restore the
   *  selection of — that old click. */
  const clearRightPointerSnapshot = useCallback(() => {
    rightPointerDown.current = null;
    selectionAtRightPointerDown.current = null;
  }, []);

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      if (!interactive) return;
      // A right-click landing inside a text field (there's no such surface on the bare pane today,
      // but see `onNodeContextMenu`) must never hijack the browser's own Copy/Paste menu.
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const moved = movedPastContextMenuThreshold(event);
      clearRightPointerSnapshot();
      if (moved) return;
      // Matches the existing plain-left-click-on-empty-canvas precedent (React Flow's own default
      // pane-click deselect) — a right-click on empty canvas is the same "click on nothing" gesture.
      useEditorStore.getState().setSelection({ nodes: [], edges: [] });
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
    [clearRightPointerSnapshot, interactive, movedPastContextMenuThreshold, screenToFlowPosition],
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
      const moved = movedPastContextMenuThreshold(event);
      // The pre-click snapshot, not a fresh read — see `selectionAtRightPointerDown`'s own comment.
      const before = selectionAtRightPointerDown.current ?? useEditorStore.getState().selection;
      clearRightPointerSnapshot();
      if (moved) return;
      const partOfMultiSelection = before.nodes.length + before.edges.length >= 2 && before.nodes.includes(node.id);
      // Either restore the multi-selection React Flow's own default click handling already
      // collapsed by this point, or replace it with just the clicked node — never leave the live
      // store holding that collapsed-to-one-node state.
      useEditorStore.getState().setSelection(partOfMultiSelection ? before : { nodes: [node.id], edges: [] });
      useUiStore.getState().setContextMenu({
        target: partOfMultiSelection ? { kind: 'selection' } : { kind: 'node', id: node.id },
        screenPosition: { x: event.clientX, y: event.clientY },
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [clearRightPointerSnapshot, interactive, movedPastContextMenuThreshold, screenToFlowPosition],
  );

  /** Mirrors `onNodeContextMenu` exactly, just against `selection.edges` — see its own comment. */
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: DraftRfEdge) => {
      if (!interactive) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const moved = movedPastContextMenuThreshold(event);
      const before = selectionAtRightPointerDown.current ?? useEditorStore.getState().selection;
      clearRightPointerSnapshot();
      if (moved) return;
      const partOfMultiSelection = before.nodes.length + before.edges.length >= 2 && before.edges.includes(edge.id);
      useEditorStore.getState().setSelection(partOfMultiSelection ? before : { nodes: [], edges: [edge.id] });
      useUiStore.getState().setContextMenu({
        target: partOfMultiSelection ? { kind: 'selection' } : { kind: 'edge', id: edge.id },
        screenPosition: { x: event.clientX, y: event.clientY },
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [clearRightPointerSnapshot, interactive, movedPastContextMenuThreshold, screenToFlowPosition],
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

  // A pan or zoom by the user slides the canvas out from under a menu pinned to a screen point, and
  // wheel/trackpad gestures never fire the pointerdown those menus close on. Programmatic moves
  // (fit, reveal) pass no event and leave them be.
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (!event) return;
    const ui = useUiStore.getState();
    if (ui.contextMenu) ui.setContextMenu(null);
    if (ui.quickConnect) {
      ui.setQuickConnect(null);
      if (ui.continuation?.trigger === 'drop') ui.setContinuation(null);
    }
  }, []);

  const onMoveEnd = useCallback(
    (event: unknown, viewport: { x: number; y: number; zoom: number }) => {
      // A camera the app moved is not a camera anybody chose, and storing it would make merely
      // stepping into a shape a change to the file — a save, a new content stamp, and every other
      // tab told the canvas changed, for looking around. React Flow reports the gesture that
      // caused a move and nothing at all for its own, which is exactly the line to draw.
      if (!event) return;
      // Persisted as document state, deliberately not as an undo step: nobody
      // wants Ctrl+Z to undo a scroll.
      useEditorStore.getState().persistViewport(viewport);
    },
    [],
  );

  const grid = document.settings.grid;

  return (
    <div
      ref={paneRef}
      className="dc-canvas"
      data-attach-drag={carryingCapsule ? 'true' : undefined}
      data-explain={explainActive ? 'on' : undefined}
      data-focus={focusActive ? 'on' : undefined}
      data-lens={lensActive ? 'on' : undefined}
      data-connect-cancelled={connectionCancelled ? 'true' : undefined}
      onPointerDownCapture={onCanvasPointerDown}
      // The one Tab stop for the whole diagram — individual nodes/edges are deliberately not
      // real DOM tab stops (see `nodesFocusable`/`edgesFocusable` below); Tab reaches "the
      // canvas" once, and Alt+Arrow/arrow-key navigation moves *selection* from there on,
      // matching `ContextMenu.tsx`'s existing virtual-focus precedent rather than adding a
      // second, competing kind of per-node DOM focus.
      tabIndex={0}
      // A plain `div` can't carry a name on its own — many screen readers ignore `aria-label` there.
      role="application"
      aria-roledescription="diagram canvas"
      aria-label="Diagram canvas"
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
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onDoubleClick={onPaneDoubleClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onPointerMove={onPointerMove}
        onMoveStart={onMoveStart}
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
        // React Flow's own default per-node/edge keyboard handling (native `tabIndex`, and its own
        // Enter/Space/Escape select-or-deselect plus arrow-key move) is turned off outright rather
        // than coordinated with: left on, it ran independently of and after `EditorScreen.tsx`'s own
        // keyboard handling for the exact same keys — a focused+selected node's arrow press could be
        // double-handled (React Flow's own uncommitted move plus this app's committed, undo-tracked
        // `nudgeSelection`), and Tab landing on an unselected node then Enter would select-then-open
        // it as an uncoordinated two-hop side effect. It also made every node and edge its own Tab
        // stop, which doesn't scale past a handful of elements. `.dc-canvas`'s own `tabIndex` above
        // is the one Tab stop for the whole diagram now; `nudgeSelection` and the new spatial/
        // relationship navigation are the only way arrow keys move anything.
        nodesFocusable={false}
        edgesFocusable={false}
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
        connectionLineStyle={connectionLineStyle}
      >
        {grid !== 'none' && (
          <Background
            variant={grid === 'lines' ? BackgroundVariant.Lines : BackgroundVariant.Dots}
            gap={grid === 'lines' ? 32 : 22}
            size={grid === 'lines' ? 1 : 1.4}
            color={theme.grid}
            // React Flow's own grid layer paints an opaque backdrop by
            // default — without this, it silently covers `.dc-canvas`'s own
            // background (and a configured background
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

          {/* Not gated on `interactive`: which room you are standing in is as true in a
              walkthrough as it is while drawing, and the frame is inert either way. */}
          <RoomFrame />

          {interactive && <ContinuationGhost />}

          {interactive && attachTarget && (
            <div
              className="dc-attach-affordance"
              style={{ transform: `translate(${attachTarget.x}px, ${attachTarget.y - 30}px)` }}
            >
              Attach to {truncateForAffordance(attachTarget.text || defaultTextFor(attachTarget.type))}
            </div>
          )}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
});

/**
 * The canvas, inside the one place that looks up React Flow's edge-label layer for every
 * connector's labels (`EdgeLabels.tsx`) — outside `CanvasBody` so that lookup isn't repeated per
 * connector, which is what made every pan frame and every click cost a DOM query per connector.
 */
export const Canvas = memo(function Canvas(props: CanvasProps) {
  return (
    <EdgeLabelRoot>
      <CanvasBody {...props} />
    </EdgeLabelRoot>
  );
});
