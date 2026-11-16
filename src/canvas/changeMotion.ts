/**
 * The imperative half of the canvas's change feedback (`useChangeFeedback.ts`): what CSS alone
 * cannot do, because the element is already gone or has already jumped.
 *
 * - **Departures.** A deleted shape or connector fades where it stood. The store notifies its
 *   subscribers before React commits, so the old drawing is still in the DOM when this runs; it is
 *   copied as an *image* of its own SVG (shapes and connectors are drawn as self-contained SVG with
 *   literal colours, the same display list the exporter writes) into a layer of its own. An image,
 *   not a DOM clone: a clone would put a second copy of the shape's words, classes and ids on the
 *   page for a moment — a second "Orders API" for anything that looks the shape up by its text.
 * - **Glides.** An undo or redo that moves shapes plays the move instead of cutting to it, the way
 *   `arrangeMotion.ts` plays a rearrangement: a FLIP on the shape's own content, so React Flow's
 *   positioning transform on the wrapper stays its own, while the connectors touching it fade back
 *   in along their new routes rather than being chased frame by frame.
 *
 * Presentation only — the document has already changed. Callers skip all of it under reduced
 * motion, and every step tolerates an element that is missing or has no Web Animations.
 */

const DEPART_MS = 200;
const GLIDE_MS = 280;

/** The house deceleration (`--dc-ease-out`) for arriving; leaving accelerates away instead. */
const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

const TRANSLATE = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)/;

export interface FlowPoint {
  x: number;
  y: number;
}

function canvasRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.dc-canvas .react-flow');
}

function zoomOf(root: HTMLElement): number {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport');
  const match = viewport ? /scale\(\s*([\d.]+)\s*\)/.exec(viewport.style.transform) : null;
  return match ? Number(match[1]) || 1 : 1;
}

function nodeWrapper(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
}

function edgeWrapper(root: HTMLElement, id: string): SVGGElement | null {
  return root.querySelector<SVGGElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"]`);
}

/** Where React Flow placed a shape, in flow coordinates (its wrapper's positioning transform). */
function flowPosition(wrapper: HTMLElement): FlowPoint | null {
  const match = TRANSLATE.exec(wrapper.style.transform);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

function svgImage(markup: string): HTMLImageElement {
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'sync';
  image.draggable = false;
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  return image;
}

/** A shape's drawing as an image positioned in flow space, or null if it is not on screen. */
function shapeGhost(root: HTMLElement, id: string, zoom: number): HTMLElement | null {
  const wrapper = nodeWrapper(root, id);
  const surface = wrapper?.querySelector<SVGSVGElement>('.dc-node-surface');
  const at = wrapper ? flowPosition(wrapper) : null;
  if (!wrapper || !surface || !at) return null;
  const outer = wrapper.getBoundingClientRect();
  const inner = surface.getBoundingClientRect();
  if (inner.width === 0 || inner.height === 0) return null;
  const image = svgImage(new XMLSerializer().serializeToString(surface));
  image.className = 'dc-departing-shape';
  image.style.left = `${at.x + (inner.left - outer.left) / zoom}px`;
  image.style.top = `${at.y + (inner.top - outer.top) / zoom}px`;
  image.style.width = `${inner.width / zoom}px`;
  image.style.height = `${inner.height / zoom}px`;
  return image;
}

/**
 * A connector's visible lines (not its wide hit path, labels or chips) as an image in flow space,
 * with the arrowheads they point to copied in — an image cannot reach the page's shared `<marker>`s.
 */
function connectorGhost(root: HTMLElement, id: string): HTMLElement | null {
  const wrapper = edgeWrapper(root, id);
  if (!wrapper) return null;
  const lines = [...wrapper.querySelectorAll<SVGPathElement>('.dc-edge-line, .dc-edge-response-line, .dc-edge-arrow')];
  if (lines.length === 0) return null;
  let box: DOMRect;
  try {
    box = wrapper.getBBox();
  } catch {
    return null;
  }
  if (box.width === 0 && box.height === 0) return null;
  const pad = 12;
  const x = box.x - pad;
  const y = box.y - pad;
  const width = box.width + pad * 2;
  const height = box.height + pad * 2;
  const markers = new Set<string>();
  const paths = lines.map((line) => {
    const copy = line.cloneNode(false) as SVGPathElement;
    copy.removeAttribute('class');
    const marker = /url\(#([^)]+)\)/.exec(line.getAttribute('marker-end') ?? '');
    if (marker?.[1]) markers.add(marker[1]);
    return new XMLSerializer().serializeToString(copy);
  });
  const defs = [...markers]
    .map((markerId) => document.getElementById(markerId))
    .filter((marker): marker is HTMLElement => marker !== null)
    .map((marker) => new XMLSerializer().serializeToString(marker))
    .join('');
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">` +
    `<defs>${defs}</defs>${paths.join('')}</svg>`;
  const image = svgImage(markup);
  image.className = 'dc-departing-connector';
  image.style.left = `${x}px`;
  image.style.top = `${y}px`;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  return image;
}

/**
 * Leaves a fading image of each departing shape and connector on the canvas. Call synchronously
 * from the store change that removes them, before React takes them off the page.
 */
export function playDepartures(nodeIds: readonly string[], edgeIds: readonly string[]): void {
  const root = canvasRoot();
  const layer = root?.querySelector<HTMLElement>('.dc-departures');
  if (!root || !layer || typeof layer.animate !== 'function') return;
  const zoom = zoomOf(root);
  const ghosts: { element: HTMLElement; shape: boolean }[] = [];
  for (const id of edgeIds) {
    const element = connectorGhost(root, id);
    if (element) ghosts.push({ element, shape: false });
  }
  for (const id of nodeIds) {
    const element = shapeGhost(root, id, zoom);
    if (element) ghosts.push({ element, shape: true });
  }
  for (const { element, shape } of ghosts) {
    layer.append(element);
    const animation = element.animate(
      shape
        ? [
            { opacity: 0.9, transform: 'scale(1)' },
            { opacity: 0, transform: 'scale(0.94)' },
          ]
        : [{ opacity: 0.8 }, { opacity: 0 }],
      { duration: DEPART_MS, easing: EASE_IN, fill: 'forwards' },
    );
    const remove = () => element.remove();
    animation.finished.then(remove, remove);
  }
}

/** Each named shape's place in flow coordinates, read before a change commits. */
export function readPositions(nodeIds: readonly string[]): Map<string, FlowPoint> {
  const out = new Map<string, FlowPoint>();
  const root = canvasRoot();
  if (!root) return out;
  for (const id of nodeIds) {
    const wrapper = nodeWrapper(root, id);
    const at = wrapper ? flowPosition(wrapper) : null;
    if (at) out.set(id, at);
  }
  return out;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Whether any of the shapes has left the place it was read at — React Flow has laid the change out. */
function laidOut(root: HTMLElement, before: ReadonlyMap<string, FlowPoint>): boolean {
  for (const [id, was] of before) {
    const wrapper = nodeWrapper(root, id);
    const now = wrapper ? flowPosition(wrapper) : null;
    if (now && (Math.abs(now.x - was.x) >= 0.5 || Math.abs(now.y - was.y) >= 0.5)) return true;
  }
  return false;
}

/**
 * Plays shapes moving from `before` to wherever React Flow puts them once the change has committed,
 * and fades the connectors in `edgeIds` back in over the same time.
 */
export async function playGlide(before: ReadonlyMap<string, FlowPoint>, edgeIds: readonly string[]): Promise<void> {
  if (before.size === 0) return;
  // React commits the new positions, then React Flow lays its nodes out — usually before the next
  // frame paints. Start in the first frame the new positions are there: waiting a fixed extra
  // frame painted the shape at its destination once before jumping it back to glide.
  let root: HTMLElement | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await frame();
    root = canvasRoot();
    if (root && laidOut(root, before)) break;
  }
  if (!root) return;
  for (const [id, was] of before) {
    const wrapper = nodeWrapper(root, id);
    const content = wrapper?.firstElementChild as HTMLElement | null | undefined;
    const now = wrapper ? flowPosition(wrapper) : null;
    if (!content || !now || typeof content.animate !== 'function') continue;
    const dx = was.x - now.x;
    const dy = was.y - now.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    content.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: GLIDE_MS,
      easing: EASE_OUT,
    });
  }
  for (const id of edgeIds) {
    const wrapper = edgeWrapper(root, id);
    if (!wrapper || typeof wrapper.animate !== 'function') continue;
    wrapper.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: GLIDE_MS + 60, easing: 'ease-out' });
  }
}
