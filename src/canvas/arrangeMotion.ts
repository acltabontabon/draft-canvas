/**
 * A rearrangement played out on the canvas instead of cut to: the connectors fade, every shape is
 * picked up and set down at its new place in a wave along the reading direction, and once they have
 * landed the connectors draw themselves back in along their new routes.
 *
 * Presentation only. The document changes once, as one undo step, before any of this plays: the
 * shapes are already where they belong, and each is drawn from where it was (a FLIP, Web Animations
 * on the node's own children, so React Flow's positioning transform on the wrapper stays its own).
 * Connectors are not chased frame by frame (their routes belong to the end state); they step aside
 * and come back drawn. With reduced motion, or without Web Animations, the change is simply made.
 */

type Rect = { x: number; y: number };

/** Milliseconds: connectors fading, each shape's flight, the wave across all of them, the redraw. */
const FADE_MS = 140;
const FLIGHT_MS = 620;
const WAVE_MS = 280;
const DRAW_MS = 460;
/** Samples per flight: straight lines between them read as the curve (see `mascot/flight.ts`). */
const SAMPLES = 24;

function reduced(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function canvasRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.react-flow');
}

function nodeElements(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) out.set(element.dataset.id!, element);
  return out;
}

const TRANSLATE = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)/;

/**
 * Each shape's place in flow coordinates, read from the positioning transform React Flow puts on the
 * wrapper. Flow space, not the screen: the flight's offsets are applied inside the zoomed viewport,
 * so screen pixels would start every shape `zoom` times too far (or too near), and a pan while the
 * layout chunk loads would shift every start.
 */
function positions(nodes: Map<string, HTMLElement>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const [id, element] of nodes) {
    const match = TRANSLATE.exec(element.style.transform);
    if (match) out.set(id, { x: Number(match[1]), y: Number(match[2]) });
  }
  return out;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** One shape's flight from `dx, dy` away: eased along the way, lifted at the middle as if carried. */
function flight(dx: number, dy: number): Keyframe[] {
  const distance = Math.hypot(dx, dy);
  const lift = Math.min(14, 4 + distance * 0.04);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = i / SAMPLES;
    const left = 1 - easeInOut(t);
    const arc = Math.sin(Math.PI * t);
    frames.push({
      offset: t,
      transform: `translate(${(dx * left).toFixed(2)}px, ${(dy * left - lift * arc).toFixed(2)}px) scale(${(1 + 0.035 * arc).toFixed(4)})`,
    });
  }
  frames[SAMPLES] = { offset: 1, transform: 'none' };
  return frames;
}

/** The layers connectors are drawn in: their routes, and their labels. */
function connectorLayers(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.react-flow__edges, .react-flow__edgelabel-renderer')];
}

function fade(layers: HTMLElement[], to: number, duration: number): Animation[] {
  return layers.map((layer) => layer.animate([{ opacity: to === 0 ? 1 : 0 }, { opacity: to }], { duration, easing: 'ease-out', fill: 'forwards' }));
}

/** Each connector's line drawn on from its start, in the order the wave set its shapes down. */
function drawConnectors(root: HTMLElement, order: (x: number, y: number) => number): Promise<void> {
  const lines = [...root.querySelectorAll<SVGPathElement>('.react-flow__edge-path')]
    .map((path) => {
      const length = typeof path.getTotalLength === 'function' ? path.getTotalLength() : 0;
      const box = path.getBoundingClientRect();
      return { path, length, at: order(box.left, box.top) };
    })
    .filter((line) => line.length > 0)
    .sort((a, b) => a.at - b.at);
  const step = lines.length > 1 ? Math.min(40, 220 / (lines.length - 1)) : 0;
  const drawn = lines.map(({ path, length }, i) =>
    path.animate(
      [
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: length },
        { strokeDasharray: `${length} ${length}`, strokeDashoffset: 0 },
      ],
      { duration: DRAW_MS, delay: i * step, easing: 'cubic-bezier(0.3, 0.6, 0.2, 1)', fill: 'backwards' },
    ).finished.catch(() => undefined),
  );
  return Promise.all(drawn).then(() => undefined);
}

/**
 * Runs `apply` (which changes the document and resolves whether anything moved) and plays the
 * rearrangement it made. `direction` is the way the diagram reads, for the wave. Resolves with
 * `apply`'s answer once the canvas has settled.
 */
export async function withArrangeMotion(apply: () => Promise<boolean>, direction: 'right' | 'down' = 'right'): Promise<boolean> {
  const root = canvasRoot();
  if (!root || reduced() || typeof root.animate !== 'function') return apply();
  const before = positions(nodeElements(root));
  const layers = connectorLayers(root);
  const out = fade(layers, 0, FADE_MS);
  let moved = false;
  try {
    moved = await apply();
  } catch (error) {
    for (const animation of out) animation.cancel();
    throw error;
  }
  if (!moved) {
    await Promise.all(fade(layers, 1, FADE_MS).map((animation) => animation.finished.catch(() => undefined)));
    for (const animation of out) animation.cancel();
    return false;
  }
  // React commits the new positions, then React Flow lays its nodes out.
  await frame();
  await frame();
  const nodes = nodeElements(root);
  const after = positions(nodes);
  const order = direction === 'right' ? (x: number, y: number) => x + y * 0.25 : (x: number, y: number) => y + x * 0.25;
  const flights = [...after]
    .map(([id, now]) => {
      const was = before.get(id);
      return was ? { id, dx: was.x - now.x, dy: was.y - now.y, at: order(now.x, now.y) } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null && Math.hypot(f.dx, f.dy) > 1)
    .sort((a, b) => a.at - b.at);
  const step = flights.length > 1 ? WAVE_MS / (flights.length - 1) : 0;
  const landed: Promise<unknown>[] = [];
  flights.forEach((f, i) => {
    const element = nodes.get(f.id)!;
    for (const child of element.children) {
      if (!(child instanceof HTMLElement || child instanceof SVGElement)) continue;
      landed.push(child.animate(flight(f.dx, f.dy), { duration: FLIGHT_MS, delay: i * step, easing: 'linear', fill: 'backwards' }).finished.catch(() => undefined));
    }
  });
  await Promise.all(landed);
  // Back in, drawn: the layers return as each line draws itself along its new route.
  for (const animation of out) animation.cancel();
  const back = fade(layers, 1, FADE_MS);
  await drawConnectors(root, order);
  for (const animation of back) animation.cancel();
  return true;
}

/** Whether a shape now lies even partly outside the canvas on screen: a layout that grew past the edge. */
export function shapesOffScreen(): boolean {
  const root = canvasRoot();
  if (!root) return false;
  const frame = root.getBoundingClientRect();
  if (frame.width === 0) return false;
  for (const element of nodeElements(root).values()) {
    const box = element.getBoundingClientRect();
    if (box.left < frame.left || box.top < frame.top || box.right > frame.right || box.bottom > frame.bottom) return true;
  }
  return false;
}
