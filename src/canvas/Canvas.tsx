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
import { createNode } from '../document/factory';
import type { DraftDocument } from '../document/types';
import type { Rect } from '../edges/routing';
import { useEditorStore } from '../store/editorStore';
import { pointer, useUiStore } from '../store/uiStore';
import { useThemeValue } from '../ui/theme/useTheme';
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

export interface CanvasProps {
  /** Called when the user asks for a new element at a point on the canvas. */
  onCreateAt?: (position: { x: number; y: number }) => void;
}

export function Canvas({ onCreateAt }: CanvasProps) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const explainActive = useEditorStore((state) => state.explain.active);
  const theme = useThemeValue();

  const store = useEditorStore;
  const { screenToFlowPosition, getNodes } = useReactFlow();

  const interactive = mode === 'edit';

  const [guides, setGuides] = useState<Guide[]>([]);

  /** Rectangles of everything not being dragged, rebuilt once per gesture. */
  const staticRects = useRef<Rect[]>([]);
  const draggingIds = useRef<Set<string>>(new Set());

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
      const snapped = snapChanges(changes, getNodes() as DraftRfNode[], staticRects.current);
      setNodes((current) => applyNodeChanges(snapped.changes, current));

      // Guides appear and disappear; they do not move every frame. Updating
      // state only when the set actually changes is what keeps drags smooth.
      setGuides((current) => (sameGuides(current, snapped.guides) ? current : snapped.guides));

      for (const change of changes) {
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
    [getNodes, setNodes, store],
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
   * own — without this handler, clicking a connector does nothing at all.
   */
  const onEdgesChange = useCallback(
    (changes: EdgeChange<DraftRfEdge>[]) => {
      setEdges((current) => applyEdgeChanges(changes, current));
    },
    [setEdges],
  );

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

      const moving = new Set(dragged.map((node) => node.id));
      draggingIds.current = moving;
      staticRects.current = state.document.nodes
        .filter((node) => !moving.has(node.id))
        .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
    },
    [store],
  );

  /**
   * Committing the drag reads the final positions from React Flow rather than
   * from inside a state updater. Updaters must stay pure: React invokes them
   * twice in development, which would write the move to history twice and make
   * a single undo look like it did nothing.
   */
  const onNodeDragStop = useCallback(() => {
    setGuides([]);
    const state = store.getState();
    const positions = new Map(
      getNodes()
        .filter((node) => draggingIds.current.has(node.id))
        .map((node) => [node.id, { x: node.position.x, y: node.position.y }] as const),
    );
    if (positions.size > 0) state.commitPositions(positions);
    state.endInteraction();
    draggingIds.current = new Set();
  }, [getNodes, store]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      store.getState().connect(connection.source, connection.target);
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
        if (droppedOn.id !== source) state.connect(source, droppedOn.id);
        return;
      }

      const sourceNode = state.document.nodes.find((node) => node.id === source);
      const created = createNode({
        type: sourceNode?.type === 'group' ? 'card' : (sourceNode?.type ?? 'card'),
        x: Math.round(position.x - 88),
        y: Math.round(position.y - 34),
        text: '',
      });
      const edge = {
        id: `e_${created.id}`,
        source,
        target: created.id,
        directed: true,
        routing: 'smoothstep' as const,
      };
      state.addNodesWithEdges([created], [edge], 'Connect to new node');
    },
    [screenToFlowPosition, store],
  );

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
    <div className="dc-canvas" data-explain={explainActive ? 'on' : undefined}>
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
          {guides.map((guide, index) => (
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
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}
