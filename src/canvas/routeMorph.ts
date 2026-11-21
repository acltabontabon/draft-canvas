import type { DraftPoint } from '../document/types';
import { morphPath, samplesOf, worthMorphing } from '../edges/morph';
import { prefersReducedMotion } from '../lib/motion';

/**
 * A connector whose route changed eases from the line it had to the line it has, instead of cutting:
 * the settled route after a drop, an undo, a reconnect. Presentation only, and canvas
 * chrome: never exported.
 *
 * The line React rendered is never touched beyond being hidden for the moment: a stand-in drawn with
 * the same stroke, dash and arrowhead does the moving, written to the DOM directly (never through
 * React state, as a live sketch is — `liveInk.ts`), and is removed when it arrives. So whatever reads
 * the real line — a test, a hit test, the next render — always reads the route it really has.
 *
 * One clock for every line in motion, and a ceiling on how many move at once: a change that reroutes
 * the whole diagram (a large Arrange, opening a room) is cut to as before, rather than sampled and
 * animated line by line.
 */

const MORPH_MS = 190;
/** More lines than this changing in one commit is a different diagram, not a line settling. */
const MAX_AT_ONCE = 48;

interface Morph {
  from: DraftPoint[];
  to: DraftPoint[];
  standIn: SVGPathElement;
  start: number;
}

interface Request {
  line: SVGPathElement;
  from: DraftPoint[] | string;
  toD: string;
}

const active = new Map<SVGPathElement, Morph>();
let pending: Request[] = [];
let frame = 0;

const ease = (t: number) => 1 - (1 - t) ** 3;

function finish(line: SVGPathElement, morph: Morph): void {
  active.delete(line);
  morph.standIn.remove();
  line.style.removeProperty('opacity');
}

function progress(morph: Morph, now: number): number {
  return Math.min(1, (now - morph.start) / MORPH_MS);
}

function tick(now: number): void {
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  for (const [line, morph] of active) {
    const t = progress(morph, now);
    if (t >= 1 || !line.isConnected) finish(line, morph);
    else morph.standIn.setAttribute('d', morphPath(morph.from, morph.to, ease(t)));
  }
  if (active.size > 0) frame = requestAnimationFrame(tick);
}

function standInFor(line: SVGPathElement): SVGPathElement {
  const standIn = line.cloneNode(false) as SVGPathElement;
  standIn.setAttribute('class', 'dc-edge-morph');
  standIn.style.removeProperty('opacity');
  line.after(standIn);
  return standIn;
}

function flush(): void {
  const requests = pending;
  pending = [];
  if (requests.length > MAX_AT_ONCE) return;
  const now = performance.now();
  for (const { line, from: asked, toD } of requests) {
    if (!line.isConnected) continue;
    const from = typeof asked === 'string' ? samplesOf(asked) : asked;
    const to = samplesOf(toD);
    if (!worthMorphing(from, to)) continue;
    const standIn = standInFor(line);
    // Before the browser paints the new route: the first frame is the old one.
    standIn.setAttribute('d', morphPath(from, to, 0));
    line.style.setProperty('opacity', '0');
    active.set(line, { from, to, standIn, start: now });
  }
  if (active.size === 0) return;
  if (frame === 0) frame = requestAnimationFrame(tick);
  // Frames can stall while the page still counts as visible (a covered window, an embedded pane).
  // The line must never be left hidden behind a stand-in that is going nowhere: a timer ends the
  // motion on time whether or not a frame ever ran.
  setTimeout(() => tick(performance.now()), MORPH_MS + 80);
}

/**
 * Asks for `line` to ease from the route `fromD` to the route `toD` (both as routed, before any
 * wobble or crossing bridge). Call from a layout effect: every line that changed in the same commit
 * is weighed together before any of them moves, and none is painted at its new route first.
 */
export function morphRoute(line: SVGPathElement, fromD: string, toD: string): void {
  // A page nobody is looking at runs no frames: the line would wait, hidden, for the tab to come back.
  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function' || document.hidden) return;
  // A line already on its way carries on from where it has got to, not from the route it left.
  const moving = active.get(line);
  let from: DraftPoint[] | string = fromD;
  if (moving) {
    const t = ease(progress(moving, performance.now()));
    from = moving.from.map((point, index) => ({
      x: point.x + (moving.to[index]!.x - point.x) * t,
      y: point.y + (moving.to[index]!.y - point.y) * t,
    }));
    finish(line, moving);
  }
  if (pending.length === 0) queueMicrotask(flush);
  pending.push({ line, from, toD });
}

/** Stops a line's motion at once: a gesture draws every frame itself, and a line leaving is gone. */
export function settleRoute(line: SVGPathElement): void {
  const moving = active.get(line);
  if (moving) finish(line, moving);
}
