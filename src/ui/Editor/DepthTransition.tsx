import { useEffect, useLayoutEffect, useRef } from 'react';
import { motionMs } from '../../lib/motion';
import { useUiStore } from '../../store/uiStore';
import { rectOfEntrance, rectOfRoom, type ScreenRect } from './depthRects';

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;
/** The corner marks' arm on the shape, as a share of its shorter side (never longer than the room
 *  frame's); and the room frame's arm — see `.dc-room-mark`. */
const SHAPE_ARM_SHARE = 0.22;
const ROOM_ARM = 28;

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * A shape becoming the room you are standing in — and, on the way out, the room closing back down
 * onto the shape.
 *
 * The room you arrive in is framed by corner marks (`RoomFrame`). So the dive is those four marks:
 * they start on the shape's own corners, open out, and land exactly on the room's frame (or the
 * canvas edges, for a room with nothing in it yet). Coming out, they close back onto the shape.
 *
 * Driven frame by frame rather than as a keyframe animation, because both ends move: the camera
 * glides into the room (or back out to the shape) over the same few hundred milliseconds, so each
 * frame re-measures its destination and lands exactly on it. Positioned by box rather than scaled,
 * so a 1px mark stays a 1px mark while it travels.
 *
 * It is a picture of a move that has already happened: the editor is showing the new room before
 * this mounts, nothing waits on it, and a second navigation simply replaces the token mid-flight.
 * Under reduced motion no token is ever set, so this renders nothing at all.
 */
export function DepthTransition() {
  const transition = useUiStore((state) => state.depthTransition);
  const frameRef = useRef<HTMLDivElement>(null);

  // Before paint, so the frame is never seen at its resting size for the one frame before it moves.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!transition || !frame) return;
    const canvasOf = () => frame.parentElement?.getBoundingClientRect() ?? null;
    const duration = motionMs(360);
    const initialCanvas = canvasOf();
    if (!initialCanvas || initialCanvas.width === 0 || duration === 0) {
      useUiStore.getState().setDepthTransition(null);
      return;
    }

    const inward = transition.direction === 'in';
    const corners = [...frame.querySelectorAll<HTMLElement>('[data-at]')];
    const veil = frame.querySelector<HTMLElement>('.dc-depth-sheet-veil');
    // The room end of the move is the room's frame, clipped to the canvas — a room larger than the
    // screen would otherwise put its marks off it — or the canvas itself when there is no frame.
    const roomEnd = (canvas: DOMRect, room: ScreenRect | null): ScreenRect => {
      if (!room) return canvas;
      const x = Math.max(room.x, canvas.x);
      const y = Math.max(room.y, canvas.y);
      const width = Math.min(room.x + room.width, canvas.right) - x;
      const height = Math.min(room.y + room.height, canvas.bottom) - y;
      return width > 0 && height > 0 ? { x, y, width, height } : canvas;
    };
    const roomStart = inward ? null : roomEnd(initialCanvas, transition.from);
    let shape: ScreenRect | null = inward ? transition.from : null;
    let started: number | null = null;
    let raf = 0;
    // Coming out, the shape is only drawn a frame or two after the room is left; the move waits
    // for it (unseen, and without starting its clock) rather than guessing, and gives up rather
    // than stalling.
    let waitsLeft = 8;

    const draw = (now: number) => {
      const canvas = canvasOf();
      if (!inward) shape = rectOfEntrance(transition.nodeId) ?? shape;
      if (!shape && started === null && waitsLeft-- > 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const room = inward && canvas ? roomEnd(canvas, rectOfRoom()) : roomStart;
      if (!canvas || !shape || !room) {
        useUiStore.getState().setDepthTransition(null);
        return;
      }
      started ??= now;
      const t = clamp01((now - started) / duration);

      // Going in, the marks hold on the shape for a beat before opening out; coming out, they close
      // straight down onto it.
      const p = inward ? easeInOut(clamp01((t - 0.1) / 0.9)) : easeOut(t);
      const from = inward ? shape : room;
      const to = inward ? room : shape;
      frame.style.left = `${mix(from.x, to.x, p) - canvas.x}px`;
      frame.style.top = `${mix(from.y, to.y, p) - canvas.y}px`;
      frame.style.width = `${mix(from.width, to.width, p)}px`;
      frame.style.height = `${mix(from.height, to.height, p)}px`;
      // Handing over to what is really there at the far end: the room's own frame, or the shape.
      frame.style.opacity = String(inward ? 1 - clamp01((t - 0.75) / 0.25) : 1 - clamp01((t - 0.85) / 0.15));

      const shapeArm = Math.min(ROOM_ARM, Math.min(shape.width, shape.height) * SHAPE_ARM_SHARE);
      const armT = inward ? p : 1 - p;
      const arm = `${mix(shapeArm, ROOM_ARM, armT)}px`;
      for (const corner of corners) {
        corner.style.width = arm;
        corner.style.height = arm;
      }
      if (veil) veil.style.opacity = String(0.25 * Math.sin(Math.PI * p));

      if (t < 1) raf = requestAnimationFrame(draw);
      else useUiStore.getState().setDepthTransition(null);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [transition]);

  useEffect(() => () => useUiStore.getState().setDepthTransition(null), []);

  if (!transition) return null;
  return (
    <div className="dc-depth-sheet" ref={frameRef} aria-hidden="true">
      <span className="dc-depth-sheet-veil" />
      {CORNERS.map((corner) => (
        <span key={corner} data-at={corner} />
      ))}
    </div>
  );
}
