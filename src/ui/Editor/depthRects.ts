/** A rectangle in viewport pixels, as `getBoundingClientRect` gives it. */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** Where a shape is on screen right now, if it is rendered — where the dive opens out of it, and
 *  where the climb closes back onto it. */
export function rectOfEntrance(nodeId: string): ScreenRect | null {
  const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (!element) return null;
  const { x, y, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** The room's frame of corner marks on screen, if the room has one (it holds at least a shape). */
export function rectOfRoom(): ScreenRect | null {
  const element = document.querySelector('.dc-room');
  if (!element) return null;
  const { x, y, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** A picture of the room being left (`pictureRoom`), for the move to carry off screen. */
export type RoomPicture = {
  /** A copy of the canvas's viewport layer: every shape, connector and label, as drawn (and the dot
   *  grid behind them, when asked for). */
  layer: HTMLElement;
  /** Where its shapes were on screen, together. */
  content: ScreenRect | null;
};

/** Past this many shapes a copy costs more than the move is worth: the room just fades. */
const MOST_PICTURED = 600;
let taken: RoomPicture | null = null;

/**
 * Copies the room on screen, just before it is swapped for another: the editor draws one room at a
 * time, and without a copy the room being left vanished the instant the move began.
 *
 * The copy is inert. Element ids, handles and the room frame's name are taken off it, so nothing
 * that finds a shape, a handle or the room on screen (`rectOfEntrance`, `rectOfRoom`, a test) finds
 * the copy instead of the real one.
 */
export function pictureRoom({ grid }: { grid: boolean }): void {
  taken = null;
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) return;
  const shapes = viewport.querySelectorAll('.react-flow__node');
  if (shapes.length > MOST_PICTURED) return;
  let content: ScreenRect | null = null;
  for (const shape of shapes) {
    const { x, y, right, bottom, width, height } = shape.getBoundingClientRect();
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
  for (const handle of layer.querySelectorAll('.react-flow__handle')) handle.remove();
  for (const frame of layer.querySelectorAll('.dc-room')) frame.classList.remove('dc-room');
  // The dot grid too, when the picture only ever grows (going in): it then zooms with the room it
  // belongs to. A shrinking picture would show the grid's own edge closing in, so that one has none.
  const backdrop = grid ? viewport.closest('.react-flow')?.querySelector('.react-flow__background') : null;
  const picture = document.createElement('div');
  if (backdrop) picture.append(backdrop.cloneNode(true));
  picture.append(layer);
  ownIds(picture);
  picture.setAttribute('aria-hidden', 'true');
  picture.setAttribute('inert', '');
  taken = { layer: picture, content };
}

const REFERS = ['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'filter', 'style', 'href'];

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
  for (const element of copy.querySelectorAll('*')) {
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
