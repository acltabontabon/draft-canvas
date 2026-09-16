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
