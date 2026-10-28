import type { DraftDocument } from '../document/types';
import { createRoomImage } from './depthImage';

/** A rectangle in viewport pixels, as `getBoundingClientRect` gives it. */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** Where a shape is on screen right now, if it is rendered — where the dive opens out of it, and
 *  where the climb closes back onto it. */
export function rectOfEntrance(nodeId: string): ScreenRect | null {
  const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (!element) return null;
  const { x, y, width, height } = visualRects()(element.getBoundingClientRect());
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The room's frame of corner marks on screen, if the room has one (it holds at least a shape). */
export function rectOfRoom(): ScreenRect | null {
  const element = document.querySelector('.dc-room');
  if (!element) return null;
  const { x, y, width, height } = visualRects()(element.getBoundingClientRect());
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** A picture of the room being left (`pictureRoom`), for the move to carry off screen. */
export type RoomPicture = {
  /** A copy of the canvas's viewport layer: every shape, connector and label, as drawn (and the dot
   *  grid behind them, when asked for). */
  layer: HTMLElement;
  /** Where its shapes were on screen, together. */
  content: ScreenRect | null;
  image: Promise<HTMLImageElement | null>;
};

/** During an image flight the editable room stays at its landing camera under the moving image. */
function visualRects(): (rect: ScreenRect) => ScreenRect & { right: number; bottom: number } {
  const arrival = document.querySelector<HTMLElement>('.dc-depth-arrival');
  if (!arrival) return (rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.x + rect.width, bottom: rect.y + rect.height });
  const pane = arrival.parentElement!.getBoundingClientRect();
  const matrix = new DOMMatrix(getComputedStyle(arrival).transform);
  return (rect) => {
    const from = matrix.transformPoint({ x: rect.x - pane.x, y: rect.y - pane.y });
    const to = matrix.transformPoint({ x: rect.x + rect.width - pane.x, y: rect.y + rect.height - pane.y });
    return { x: pane.x + from.x, y: pane.y + from.y, width: to.x - from.x, height: to.y - from.y, right: pane.x + to.x, bottom: pane.y + to.y };
  };
}

/** Past this many shapes a copy costs more than the move is worth: the room just fades. */
const MOST_PICTURED = 600;
/** Also bounds connector-heavy rooms and the pictures carried through rapid replacement moves. */
const MOST_PICTURED_ELEMENTS = 24_000;
/** Decoded SVG images count as one DOM element but can retain a whole room's drawing. */
const MOST_CARRIED_PICTURES = 6;
let taken: RoomPicture | null = null;

/**
 * Copies the room on screen, just before it is swapped for another: the editor draws one room at a
 * time, and without a copy the room being left vanished the instant the move began.
 *
 * The copy is inert. Element ids, handles and the room frame's name are taken off it, so nothing
 * that finds a shape, a handle or the room on screen (`rectOfEntrance`, `rectOfRoom`, a test) finds
 * the copy instead of the real one.
 */
export function pictureRoom({ grid, room, selectedFlowId }: { grid: boolean; room: DraftDocument; selectedFlowId?: string | null }): void {
  taken = null;
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) return;
  const shapes = viewport.querySelectorAll('.react-flow__node');
  if (shapes.length > MOST_PICTURED) return;
  const root = viewport.closest('.react-flow');
  const previous = root?.querySelector<HTMLElement>('.dc-depth-ghost');
  const arriving = root?.querySelector<HTMLElement>('.dc-depth-arrival');
  if (viewport.getElementsByTagName('*').length + (previous?.getElementsByTagName('*').length ?? 0) > MOST_PICTURED_ELEMENTS) return;
  let content: ScreenRect | null = null;
  const onScreen = visualRects();
  for (const shape of shapes) {
    const { x, y, right, bottom, width, height } = onScreen(shape.getBoundingClientRect());
    if (width === 0 || height === 0) continue;
    if (!content) content = { x, y, width, height };
    else {
      const left = Math.min(content.x, x);
      const top = Math.min(content.y, y);
      content = {
        x: left,
        y: top,
        width: Math.max(content.x + content.width, right) - left,
        height: Math.max(content.y + content.height, bottom) - top,
      };
    }
  }
  const layer = viewport.cloneNode(true) as HTMLElement;
  // cloneNode omits WAAPI effects. A second move can capture a room mid-flight: use its visible
  // camera and opacity, just as the screen rectangles above do, rather than its landing camera.
  const pose = getComputedStyle(viewport);
  layer.style.transform = pose.transform;
  layer.style.opacity = pose.opacity;
  const parent = viewport.parentElement;
  const outer = parent ? getComputedStyle(parent) : null;
  if (outer?.transform && outer.transform !== 'none') {
    layer.style.transform = new DOMMatrix(outer.transform).multiply(new DOMMatrix(pose.transform)).toString();
  }
  layer.style.opacity = String(Number(outer?.opacity || 1) * Number(pose.opacity || 1));
  for (const handle of layer.querySelectorAll('.react-flow__handle')) handle.remove();
  for (const frame of layer.querySelectorAll('.dc-room')) frame.classList.remove('dc-room');
  // The dot grid too, when the picture only ever grows (going in): it then zooms with the room it
  // belongs to. A shrinking picture would show the grid's own edge closing in, so that one has none.
  const backdrop = grid ? root?.querySelector('.react-flow__background') : null;
  const picture = document.createElement('div');
  picture.className = 'dc-depth-picture';
  if (backdrop) picture.append(backdrop.cloneNode(true));
  picture.append(layer);
  if (arriving) {
    const remainder = arriving.cloneNode(true) as HTMLElement;
    const visible = getComputedStyle(arriving);
    remainder.className = 'dc-depth-arrival-picture';
    remainder.style.transform = visible.transform;
    remainder.style.opacity = visible.opacity;
    picture.append(remainder);
  }
  // Reversing before the fade finishes still shows part of the preceding room. Carry that
  // composed picture too; copying only the almost-transparent live room would flash blank.
  if (previous) {
    const remainder = previous.cloneNode(true) as HTMLElement;
    const visible = getComputedStyle(previous);
    remainder.className = 'dc-depth-remainder';
    remainder.style.transform = visible.transform;
    remainder.style.opacity = visible.opacity;
    remainder.querySelectorAll('.dc-depth-remainder')[MOST_CARRIED_PICTURES - 1]?.remove();
    picture.append(remainder);
  }
  ownIds(picture);
  picture.setAttribute('aria-hidden', 'true');
  picture.setAttribute('inert', '');
  const box = root?.getBoundingClientRect();
  let image: Promise<HTMLImageElement | null> = Promise.resolve(null);
  if (box && box.width > 0 && box.height > 0) {
    const camera = new DOMMatrix(layer.style.transform || 'none');
    image = createRoomImage(room, { x: camera.m41, y: camera.m42, zoom: camera.m22 }, box, { selectedFlowId: selectedFlowId ?? undefined }).then((image) => {
      image.style.opacity = layer.style.opacity;
      return image;
    }, () => null);
  }
  taken = { layer: picture, content, image };
}

const REFERS = ['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'filter', 'style', 'href'];
const REFERENCES = REFERS.map((name) => `[${name}*="#"]`).join(',');

/**
 * Gives a copy ids of its own. A copied arrowhead or grid pattern that kept its id resolved to the
 * live room's, which moves with the camera, so the copy's dots and arrows slid about under it.
 */
function ownIds(copy: HTMLElement): void {
  for (const element of copy.querySelectorAll('[data-id]')) element.removeAttribute('data-id');
  const renamed = new Map<string, string>();
  for (const element of copy.querySelectorAll('[id]')) {
    renamed.set(element.id, `${element.id}-picture`);
    element.id = `${element.id}-picture`;
  }
  if (renamed.size === 0) return;
  // Most descendants are text, controls or paths without a URL. Query the referencing elements
  // once instead of reading eleven attributes on every descendant in a dense room's copy.
  for (const element of copy.querySelectorAll(REFERENCES)) {
    for (const name of REFERS) {
      const value = element.getAttribute(name);
      if (!value?.includes('#')) continue;
      const next = value.replace(/#([^)"'\s]+)/g, (whole, id: string) => (renamed.has(id) ? `#${renamed.get(id)}` : whole));
      if (next !== value) element.setAttribute(name, next);
    }
  }
}

/** The picture `pictureRoom` took for this move, once: a later move takes its own. */
export function takePicture(): RoomPicture | null {
  const picture = taken;
  taken = null;
  return picture;
}
