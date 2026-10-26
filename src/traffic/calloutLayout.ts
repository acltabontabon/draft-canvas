import type { Rect } from './sketchLayout';

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}

/** A selected shape's explanation must also clear the findings already written beside it. */
export function placeCallout(anchor: Rect, width: number, height: number, obstacles: readonly Rect[]): Rect {
  const padded = [anchor, ...obstacles].map((rect) => ({
    x: rect.x - 6,
    y: rect.y - 6,
    width: rect.width + 12,
    height: rect.height + 12,
  }));
  const candidates: Rect[] = [];
  for (const gap of [26, 56, 86]) {
    candidates.push(
      { x: anchor.x + anchor.width + gap, y: anchor.y - 6, width, height },
      { x: anchor.x - width - gap, y: anchor.y - 6, width, height },
      { x: anchor.x, y: anchor.y + anchor.height + gap, width, height },
      { x: anchor.x, y: anchor.y - height - gap, width, height },
    );
  }
  // A crowded diagram may fill every nearby side. Its outside edges always offer a clear place,
  // rather than letting the explanation cover another finding or resource.
  const minX = Math.min(...padded.map((rect) => rect.x));
  const minY = Math.min(...padded.map((rect) => rect.y));
  const maxX = Math.max(...padded.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...padded.map((rect) => rect.y + rect.height));
  candidates.push(
    { x: maxX + 20, y: anchor.y - 6, width, height },
    { x: minX - width - 20, y: anchor.y - 6, width, height },
    { x: anchor.x, y: maxY + 20, width, height },
    { x: anchor.x, y: minY - height - 20, width, height },
  );
  return candidates.find((candidate) => padded.every((rect) => overlap(candidate, rect) === 0))!;
}
