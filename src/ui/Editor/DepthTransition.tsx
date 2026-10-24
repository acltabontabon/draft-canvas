import { useEffect, useLayoutEffect, useRef } from 'react';
import { useReactFlow, type Viewport } from '@xyflow/react';
import { cameraEntering, cameraLeaving, DEPTH_MOVE_MS, depthEase, fitCamera, type PaneRect } from '../../canvas/depthCamera';
import { boundsOf, type Bounds } from '../../document/geometry';
import { motionMs } from '../../lib/motion';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { takePicture, type RoomPicture } from './depthRects';

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** 0 before `from`, 1 after `to`, smoothly between: when each room is seen, over the move. */
const between = (t: number, from: number, to: number) => {
  const x = clamp01((t - from) / (to - from));
  return x * x * (3 - 2 * x);
};
/** Frames worked out for the compositor to run between: enough that the zoom's curve reads as one. */
const FRAMES = 32;

/**
 * Stepping into a shape, and back out of it, as one continuous zoom through the shape.
 *
 * The editor draws one room at a time, so the room being left is carried off as a picture of
 * itself (`pictureRoom`), held in step with the camera. Going in, the room you leave keeps growing
 * past you, the shape's outline opening around the room inside it, which grows up out of the shape
 * to where Fit to view (Shift 1) frames it, while the one you left dissolves. Coming out, the room
 * shrinks back into its shape, and the room around it settles in as it does, from just closer than
 * where it lands.
 *
 * Both rooms move by the same zoom about the same point, every frame, so the shape and what is
 * inside it never part: that is what makes it read as going through the shape rather than as a cut
 * and a pan. The far room fades in and the near one out, so a shape is never seen filling the
 * screen at full strength. The camera itself lands at once, and both rooms are moved as layers by
 * the compositor, so nothing on the page's own thread can make the move stutter.
 *
 * It is the picture of a move that has already happened: the editor is in the new room before this
 * runs, nothing waits on it, a second move replaces it mid-flight, and reaching for the canvas
 * mid-move ends it at once. It always ends where Fit to view would. Under reduced
 * motion no move is ever played, and the canvas lands at once (`Canvas`'s room camera).
 */
export function DepthTransition() {
  const transition = useUiStore((state) => state.depthTransition);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { setViewport } = useReactFlow();

  // Before paint, so neither room is ever seen at rest for the frame before it moves.
  useLayoutEffect(() => {
    if (!transition) return;
    const picture = takePicture();
    const done = () => useUiStore.getState().setDepthTransition(null);
    const root = anchorRef.current?.parentElement?.querySelector<HTMLElement>('.react-flow') ?? null;
    const live = root?.querySelector<HTMLElement>('.react-flow__viewport') ?? null;
    // The dot grid zooms with the camera: arriving from eleven times closer, it was giant dots.
    const grid = root?.querySelector<HTMLElement>('.react-flow__background') ?? null;
    const box = root?.getBoundingClientRect();
    const room = useEditorStore.getState().document;
    const landing = box ? fitCamera(room.nodes, box) : null;
    const duration = motionMs(DEPTH_MOVE_MS);
    if (!root || !live || !box || box.width === 0 || duration === 0) {
      if (landing) void setViewport(landing);
      done();
      return;
    }
    const onPane = (rect: PaneRect): PaneRect => ({ ...rect, x: rect.x - box.x, y: rect.y - box.y });
    const plan = flightOf(transition, picture, room.nodes, onPane, box, landing ?? room.viewport);

    // The picture rides above the live room, inside the canvas, so every control stays above both.
    const ghost = document.createElement('div');
    ghost.className = 'dc-depth-ghost';
    if (picture) ghost.append(picture.layer);
    root.append(ghost);

    // The camera goes straight to where it lands, once; what is seen moving is the two rooms as
    // layers, animated by the compositor from frames worked out here. Driving the camera itself
    // every frame re-laid and repainted the whole room each time, at up to eleven times its size
    // coming out, and the move stuttered.
    const to = plan.to;
    void setViewport(to);
    const layer = live.parentElement ?? live;
    const frames = { room: [] as Keyframe[], picture: [] as Keyframe[], grid: [] as Keyframe[] };
    for (let i = 0; i <= FRAMES; i += 1) {
      const t = i / FRAMES;
      const e = depthEase(t);
      const zoom = plan.from.zoom * (plan.to.zoom / plan.from.zoom) ** e;
      const cx = plan.anchorFrom.x + (plan.anchorTo.x - plan.anchorFrom.x) * e;
      const cy = plan.anchorFrom.y + (plan.anchorTo.y - plan.anchorFrom.y) * e;
      const camera = { x: cx - plan.anchor.x * zoom, y: cy - plan.anchor.y * zoom, zoom };
      // The room as the camera would show it now, from the camera it has: a zoom about the origin.
      const s = camera.zoom / to.zoom;
      const arriving = between(t, ...plan.arriving);
      frames.room.push({ offset: t, transform: `translate(${camera.x - s * to.x}px, ${camera.y - s * to.y}px) scale(${s})`, opacity: arriving });
      // The picture: zoomed by just as much as the camera has since it set off, about the same point.
      const scale = plan.picture ? plan.picture ** e : zoom / plan.from.zoom;
      frames.picture.push({ offset: t, transform: `translate(${cx - scale * plan.anchorFrom.x}px, ${cy - scale * plan.anchorFrom.y}px) scale(${scale})`, opacity: 1 - between(t, ...plan.leaving) });
      // The dot grid only fades: zoomed with the camera, arriving from eleven times closer, it was
      // giant dots.
      frames.grid.push({ offset: t, opacity: arriving });
    }
    const timing: KeyframeAnimationOptions = { duration, easing: 'linear' };
    layer.style.transformOrigin = '0 0';
    layer.style.willChange = 'transform, opacity';
    const animations = [layer.animate(frames.room, timing), ghost.animate(frames.picture, timing), ...(grid ? [grid.animate(frames.grid, timing)] : [])];

    let over = false;
    const settle = () => {
      if (over) return;
      over = true;
      for (const animation of animations) animation.cancel();
      ghost.remove();
      layer.style.transformOrigin = '';
      layer.style.willChange = '';
      root.removeEventListener('wheel', interrupted, true);
      root.removeEventListener('pointerdown', interrupted, true);
    };
    const finish = () => {
      settle();
      done();
    };
    // The person reaching for the canvas mid-move gets it as it will be, at once.
    const interrupted = () => finish();
    root.addEventListener('wheel', interrupted, { capture: true, passive: true });
    root.addEventListener('pointerdown', interrupted, true);
    void animations[0]!.finished.then(finish, () => {});
    return settle;
  }, [transition, setViewport]);

  useEffect(() => () => useUiStore.getState().setDepthTransition(null), []);

  // Only something to find the canvas from; everything seen is drawn inside the canvas itself.
  return transition ? <div className="dc-depth-sheet" ref={anchorRef} hidden /> : null;
}

type Flight = {
  from: Viewport;
  to: Viewport;
  /** The point the zoom is about, on the canvas of the room arriving… */
  anchor: { x: number; y: number };
  /** …and where it is on screen as the move sets off, and as it lands. */
  anchorFrom: { x: number; y: number };
  anchorTo: { x: number; y: number };
  /** When the room arriving is seen, and the one being left stops being seen, as parts of the move. */
  arriving: [number, number];
  leaving: [number, number];
  /** How far the picture zooms by itself, when the camera doesn't move. */
  picture?: number;
};

/** How far the picture zooms when there is no shape to zoom through. */
const EMPTY_ZOOM = 3;

/** For when there is no shape to zoom through (an empty room, or a shape no longer there): only the
 *  picture moves, by `factor` about one point on screen. The camera stays put: someone arriving in
 *  an empty room draws in it at once, and a camera still moving put the first shape elsewhere. */
function about(to: Viewport, point: { x: number; y: number }, factor: number, arriving: [number, number], leaving: [number, number]): Flight {
  const anchor = { x: (point.x - to.x) / to.zoom, y: (point.y - to.y) / to.zoom };
  return { from: to, to, anchor, anchorFrom: point, anchorTo: point, arriving, leaving, picture: factor };
}

const centreOf = (b: Bounds) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const onScreen = (point: { x: number; y: number }, camera: Viewport) => ({
  x: point.x * camera.zoom + camera.x,
  y: point.y * camera.zoom + camera.y,
});

/** Where the move sets off from and lands, and about which point it zooms. */
function flightOf(
  transition: NonNullable<ReturnType<typeof useUiStore.getState>['depthTransition']>,
  picture: RoomPicture | null,
  nodes: readonly Bounds[],
  onPane: (rect: PaneRect) => PaneRect,
  box: DOMRect,
  to: Viewport,
): Flight {
  const pane = { x: 0, y: 0, width: box.width, height: box.height };
  const content = boundsOf(nodes);
  if (transition.direction === 'in') {
    // The room's shapes start small inside the shape stepped into, and grow out of it.
    const entrance = transition.from ? onPane(transition.from) : pane;
    const from = content ? cameraEntering(nodes, entrance) : null;
    const anchor = content ? centreOf(content) : { x: 0, y: 0 };
    // An empty room: nothing to grow, so the one left behind opens up around the shape and goes.
    if (!from || !content) return about(to, centreOf(entrance), EMPTY_ZOOM, [0, 0.4], [0, 0.45]);
    return { from, to, anchor, anchorFrom: onScreen(anchor, from), anchorTo: onScreen(anchor, to), arriving: [0.06, 0.5], leaving: [0.04, 0.5] };
  }
  // Coming out, the shape starts around where the room's shapes were, so the room shrinks back
  // into it; the room around it only shows once the shape is near its own size again.
  const owner = useEditorStore.getState().document.nodes.find((node) => node.id === transition.nodeId);
  const left = picture?.content ? onPane(picture.content) : transition.from ? onPane(transition.from) : pane;
  if (!owner) return about(to, centreOf(left), 1 / EMPTY_ZOOM, [0, 0.4], [0, 0.4]);
  const from = cameraLeaving(owner, left);
  const anchor = centreOf(owner);
  return { from, to, anchor, anchorFrom: onScreen(anchor, from), anchorTo: onScreen(anchor, to), arriving: [0.24, 0.7], leaving: [0.3, 0.8] };
}
