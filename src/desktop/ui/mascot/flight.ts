/**
 * Nodi's jumps, as Web Animations on the mascot's own button: out of its bunk in the status bar up
 * onto the canvas (`rise`), back down into it (`sink`), and between resting and the open
 * conversation (`hop`). Each is a FLIP: the button is laid out where it ends up (or starts), and the
 * jump is drawn from the other box with transforms alone, so nothing is laid out again mid-air.
 *
 * The path is sampled, not tweened between a few poses: eased keyframes stop the sideways motion at
 * every pose and the jump stutters along a kinked line. Sampled, it is one throw: steady sideways
 * speed, a true parabola up and down, the size growing (or shrinking) smoothly, and squash and
 * stretch from the vertical speed — a crouch before take-off, a stretch in the air, a squash that
 * rings out on landing. Anchored at the feet (`transform-origin: 50% 100%`), so a squash flattens
 * Nodi onto whatever it lands on rather than toward its middle.
 */

export type Jump = 'rise' | 'sink' | 'hop';

export const JUMP_MS: Record<Jump, number> = { rise: 760, sink: 640, hop: 480 };

type Box = Pick<DOMRect, 'left' | 'width' | 'bottom' | 'height'>;

/** From `box` to where `element` is laid out: the move, in screen pixels, and the scale, feet to feet. */
function offset(element: HTMLElement, box: Box) {
  const here = element.getBoundingClientRect();
  if (here.width === 0 || here.height === 0) return null;
  return {
    dx: box.left + box.width / 2 - (here.left + here.width / 2),
    dy: box.bottom - here.bottom,
    s: box.width / here.width,
  };
}

/** Samples a jump: enough that straight segments between them read as a curve at 60fps. */
const SAMPLES = 40;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

type Pose = { x: number; y: number; sx: number; sy: number };

type Throw = {
  /** Where it takes off and lands, relative to where it is laid out, and its size at each end. */
  from: { x: number; y: number; size: number };
  to: { x: number; y: number; size: number };
  /** How far above the higher end the arc peaks. */
  height: number;
  /** The share of the time spent crouching first, and settling after. */
  crouch: number;
  settle: number;
  /** How deep the crouch and the landing squash go. */
  squash: number;
};

function pose(jump: Throw, t: number): Pose {
  const { from, to, crouch, settle, squash } = jump;
  const air = 1 - crouch - settle;
  if (t < crouch) {
    // Gathering itself: down on its haunches where it stands.
    const k = Math.sin((t / crouch) * (Math.PI / 2));
    return { x: from.x, y: from.y, sx: from.size * (1 + squash * k), sy: from.size * (1 - squash * k) };
  }
  if (t <= crouch + air) {
    const u = (t - crouch) / air;
    // Steady sideways, a parabola up and down: the arc peaks `height` over the higher end.
    const base = lerp(from.y, to.y, u);
    const peak = Math.min(from.y, to.y) - jump.height - lerp(from.y, to.y, 0.5);
    const y = base + 4 * peak * u * (1 - u);
    const size = lerp(from.size, to.size, easeInOut(u));
    // Stretched by its speed, most at take-off and landing, none at the top; out of the crouch in the
    // first tenth of the air rather than in one frame.
    const speed = Math.abs(1 - 2 * u);
    const unwind = clamp01(u / 0.1);
    const stretch = 0.16 * speed * unwind;
    const left = squash * (1 - unwind);
    return { x: lerp(from.x, to.x, u), y, sx: size * (1 - stretch * 0.6 + left), sy: size * (1 + stretch - left) };
  }
  // Landed: a squash that rings out.
  const u = (t - crouch - air) / settle;
  const ring = squash * 0.9 * Math.exp(-4.5 * u) * Math.cos(u * Math.PI * 2.5);
  return { x: to.x, y: to.y, sx: to.size * (1 + ring), sy: to.size * (1 - ring) };
}

function throwOf(jump: Jump, dx: number, dy: number, s: number): Throw {
  if (jump === 'rise') {
    // From the bunk, small, up past its place and down onto it, full size.
    return { from: { x: dx, y: dy, size: s }, to: { x: 0, y: 0, size: 1 }, height: 34, crouch: 0.12, settle: 0.24, squash: 0.2 };
  }
  if (jump === 'sink') {
    // From its place up a little and down into the bunk, shrinking as it goes; it lands small.
    return { from: { x: 0, y: 0, size: 1 }, to: { x: dx, y: dy, size: s }, height: 26, crouch: 0.14, settle: 0.14, squash: 0.16 };
  }
  // A small hop from one place on the canvas to the other, over whichever is higher.
  return { from: { x: dx, y: dy, size: 1 }, to: { x: 0, y: 0, size: 1 }, height: 18, crouch: 0.14, settle: 0.22, squash: 0.12 };
}

const transformOf = ({ x, y, sx, sy }: Pose) => `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

function keyframes(jump: Jump, dx: number, dy: number, s: number): Keyframe[] {
  const path = throwOf(jump, dx, dy, s);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = i / SAMPLES;
    frames.push({ offset: t, transform: transformOf(pose(path, t)) });
  }
  // Landed exactly where it is laid out, with nothing left over.
  if (jump !== 'sink') frames[SAMPLES] = { offset: 1, transform: 'none' };
  return frames;
}

/**
 * Plays `jump` on `element` against `box`: where it comes from for `rise` and `hop`, where it goes
 * for `sink`. Null where there is nothing to play (no Web Animations, as in tests; an element not laid
 * out); the caller's own timer then moves things on.
 */
export function playJump(element: HTMLElement, jump: Jump, box: Box): Animation | null {
  if (typeof element.animate !== 'function') return null;
  const move = offset(element, box);
  if (!move) return null;
  // A hop between two places that are the same place is no hop.
  if (jump === 'hop' && Math.abs(move.dx) < 2 && Math.abs(move.dy) < 2) return null;
  return element.animate(keyframes(jump, move.dx, move.dy, move.s), {
    duration: JUMP_MS[jump],
    // Sampled finely enough that straight lines between samples are the curve.
    easing: 'linear',
    // Down in the bunk it stays put until the bunk's own Nodi takes over.
    fill: jump === 'sink' ? 'forwards' : 'none',
  });
}
