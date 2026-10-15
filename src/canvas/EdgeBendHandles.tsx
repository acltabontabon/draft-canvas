import { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { DraftPoint, EdgeRouting } from '../document/types';
import { flattenPath, type RoutedEdge } from '../edges/routing';
import { bendsOf, isLevel, simplifyPolyline, slideSegment, stepPolyline } from '../edges/waypoints';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/** A drag's bends, drawn before they are committed. `waypoints` absent: the drag has straightened
 *  the line out, and it is being drawn by the router again. */
export interface BendPreview {
  waypoints: DraftPoint[] | undefined;
}

/** Screen pixels a pointer must travel before a press on a handle counts as a drag — the same
 *  allowance the endpoint handles give a click. */
const DRAG_THRESHOLD_PX = 4;

/** Screen pixels within which a dragged run or bend snaps level with what it can line up with. */
const SNAP_PX = 6;

/** A run shorter than this, in screen pixels, is too short to grab without hiding its own line. */
const MIN_HANDLE_RUN_PX = 18;

type Handle =
  /** A stepped connector's run, slid sideways. `index` is the run's start in `polyline`. */
  | { kind: 'run'; index: number; level: boolean; x: number; y: number }
  /** A straight or curved connector's bend, moved freely; removed with a double-click. */
  | { kind: 'bend'; index: number; x: number; y: number }
  /** Between two of a straight or curved connector's points: dragging it adds a bend there. */
  | { kind: 'add'; index: number; x: number; y: number };

interface Gesture {
  element: HTMLDivElement;
  handle: Handle;
  pointerId: number;
  startClient: { x: number; y: number };
  startFlow: { x: number; y: number };
  /** The line as it was when the drag began; every frame is computed from this, never from the
   *  previous frame, so a drag can always be undone by moving back. */
  polyline: DraftPoint[];
  waypoints: DraftPoint[];
  zoom: number;
  started: boolean;
}

/**
 * The handles that make a selected connector's path editable, drawn over the line itself.
 *
 * A stepped connector is edited a run at a time — each straight run has a handle at its middle that
 * slides it sideways, its neighbours stretching to follow — so it stays orthogonal by construction.
 * A straight or curved connector has a handle on each bend to move it, and a fainter one between
 * any two points to add a bend there; a double-click on a bend removes it.
 *
 * Until the first drag the line is the router's, and the handles sit on the route it drew; that
 * route becomes the starting point of the user's own. "Reset route" hands it back.
 */
export function EdgeBendHandles({
  edgeId,
  routing,
  route,
  waypoints,
  onPreview,
}: {
  edgeId: string;
  routing: EdgeRouting;
  route: RoutedEdge;
  waypoints: DraftPoint[] | undefined;
  onPreview: (preview: BendPreview | null) => void;
}) {
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const gesture = useRef<Gesture | null>(null);
  // The handle being dragged, and where it is now. While a drag runs it is the only handle drawn,
  // and it keeps its key: the line it rides on changes shape every frame, and a handle list rebuilt
  // from that would hand the grabbed one's key to another run — unmounting the element holding the
  // pointer capture, which strands the drag half-done with nothing to finish it.
  const [dragging, setDragging] = useState<{ handle: Handle; at: DraftPoint } | null>(null);
  const onKeyDown = useRef<((event: KeyboardEvent) => void) | undefined>(undefined);
  const stepped = routing !== 'straight' && routing !== 'bezier';
  const polyline = route.points ?? (stepped ? stepPolyline(route.d) : [route.source, route.target]);
  // Only the selected connector mounts this, so following the zoom costs one component, not all.
  const zoom = useStore((state) => state.transform[2]);
  const handles = handlesFor(polyline, stepped, route.d, MIN_HANDLE_RUN_PX / zoom);

  const end = useCallback(() => {
    if (onKeyDown.current) window.removeEventListener('keydown', onKeyDown.current);
    onKeyDown.current = undefined;
    if (gesture.current?.started) useUiStore.getState().setInteractionActive(false);
    gesture.current = null;
    setDragging(null);
    onPreview(null);
  }, [onPreview]);

  // Unmounting mid-drag (the connector deleted, Present entered) must not leave the canvas thinking
  // a gesture is still running — the same guard `EdgeEndpointHandle` keeps.
  const endRef = useRef(end);
  useEffect(() => {
    endRef.current = end;
  }, [end]);
  useEffect(() => () => endRef.current(), []);

  const bendsAt = (current: Gesture, clientX: number, clientY: number): { bends: DraftPoint[] | undefined; at: DraftPoint } => {
    const point = screenToFlowPosition({ x: clientX, y: clientY });
    const dx = point.x - current.startFlow.x;
    const dy = point.y - current.startFlow.y;
    const snap = SNAP_PX / current.zoom;
    const { handle } = current;
    if (handle.kind === 'run') {
      const line = current.polyline;
      const a = line[handle.index]!;
      let value = handle.level ? a.y + dy : a.x + dx;
      // Level with either end, or with another run going the same way: the snaps that take a jog
      // out of a line rather than put one in.
      const candidates: number[] = [];
      for (let i = 0; i < line.length - 1; i += 1) {
        if (i === handle.index || isLevel(line[i]!, line[i + 1]!) !== handle.level) continue;
        candidates.push(handle.level ? line[i]!.y : line[i]!.x);
      }
      const first = line[0]!;
      const last = line[line.length - 1]!;
      candidates.push(handle.level ? first.y : first.x, handle.level ? last.y : last.x);
      value = snapTo(value, candidates, snap);
      const bends = bendsOf(simplifyPolyline(slideSegment(line, handle.index, value)));
      return {
        bends: bends.length > 0 ? bends : undefined,
        at: handle.level ? { x: handle.x, y: value } : { x: value, y: handle.y },
      };
    }
    const bends = current.waypoints.map((p) => ({ ...p }));
    const { index } = handle;
    const origin = handle.kind === 'add' ? { x: handle.x, y: handle.y } : current.waypoints[index]!;
    if (handle.kind === 'add') bends.splice(index, 0, origin);
    // Neighbours along the whole line, ends included, so a bend can line up with a shape's anchor.
    const all = [current.polyline[0]!, ...bends, current.polyline[current.polyline.length - 1]!];
    const before = all[index]!;
    const after = all[index + 2]!;
    bends[index] = {
      x: Math.round(snapTo(origin.x + dx, [before.x, after.x], snap)),
      y: Math.round(snapTo(origin.y + dy, [before.y, after.y], snap)),
    };
    return { bends, at: bends[index]! };
  };

  const onPointerDown = (handle: Handle) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    // A second finger mid-drag is ignored; a gesture whose element lost the pointer some way that
    // fired nothing is over, and must not lock every handle out.
    if (gesture.current) {
      if (gesture.current.element.hasPointerCapture(gesture.current.pointerId)) return;
      end();
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      element: event.currentTarget,
      handle,
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startFlow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      polyline: polyline.map((p) => ({ x: p.x, y: p.y })),
      waypoints: waypoints ?? [],
      zoom: getZoom(),
      started: false,
    };
    onKeyDown.current = (keyEvent) => {
      if (keyEvent.key === 'Escape') end();
    };
    window.addEventListener('keydown', onKeyDown.current);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.started) {
      const moved = Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y);
      if (moved < DRAG_THRESHOLD_PX) return;
      current.started = true;
      useUiStore.getState().setInteractionActive(true);
    }
    const { bends, at } = bendsAt(current, event.clientX, event.clientY);
    setDragging({ handle: current.handle, at });
    onPreview({ waypoints: bends });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const bends = current.started ? bendsAt(current, event.clientX, event.clientY).bends : null;
    end();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (bends !== null) useEditorStore.getState().setEdgeWaypoints(edgeId, bends);
  };

  const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.current && event.pointerId === gesture.current.pointerId) end();
  };

  const removeBend = (index: number) => (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!waypoints) return;
    useEditorStore.getState().setEdgeWaypoints(edgeId, waypoints.filter((_, i) => i !== index));
  };

  return (
    <>
      {(dragging ? [{ ...dragging.handle, x: dragging.at.x, y: dragging.at.y }] : handles).map((handle) => (
        <div
          key={`${handle.kind}:${handle.index}`}
          className="dc-edge-bend"
          data-kind={handle.kind}
          data-level={handle.kind === 'run' ? String(handle.level) : undefined}
          data-dragging={dragging ? 'true' : undefined}
          title={handle.kind === 'run' ? 'Drag to move this part of the line' : handle.kind === 'bend' ? 'Drag to move · double-click to remove' : 'Drag to add a bend'}
          style={{ transform: `translate(-50%, -50%) translate(${handle.x}px, ${handle.y}px)` }}
          onPointerDown={onPointerDown(handle)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onDoubleClick={handle.kind === 'bend' ? removeBend(handle.index) : (event) => event.stopPropagation()}
        />
      ))}
    </>
  );
}

/** Where the handles go on the line as drawn. */
function handlesFor(polyline: readonly DraftPoint[], stepped: boolean, d: string, minRun: number): Handle[] {
  const handles: Handle[] = [];
  if (stepped) {
    for (let i = 0; i < polyline.length - 1; i += 1) {
      const a = polyline[i]!;
      const b = polyline[i + 1]!;
      const level = isLevel(a, b);
      if (level === undefined || Math.hypot(b.x - a.x, b.y - a.y) < minRun) continue;
      handles.push({ kind: 'run', index: i, level, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    return handles;
  }
  const curve = flattenPath(d);
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < minRun * 2) continue;
    // On the line itself: a curve's chord midpoint is off it, so take the drawn point nearest that.
    const mid = nearestOn(curve, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    handles.push({ kind: 'add', index: i, x: mid.x, y: mid.y });
  }
  for (let i = 1; i < polyline.length - 1; i += 1) handles.push({ kind: 'bend', index: i - 1, x: polyline[i]!.x, y: polyline[i]!.y });
  return handles;
}

function nearestOn(points: readonly DraftPoint[], target: DraftPoint): DraftPoint {
  let best = target;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / lengthSq));
    const p = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best;
}

function snapTo(value: number, candidates: readonly number[], within: number): number {
  let best = value;
  let bestDistance = within;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
