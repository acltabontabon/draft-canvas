import { useLayoutEffect, useState, type RefObject } from 'react';

type Point = { x: number; y: number };

/** Where Home's connectors start and end, measured from layout rather than guessed. */
export interface DeskGeometry {
  width: number;
  height: number;
  /** The motto node's bottom anchor, and the Quick Draft node's top and bottom. */
  motto: Point;
  actionTop: Point;
  actionBottom: Point;
  /** Where the bus runs, between the row's label and its drawings. */
  busY: number;
  /** The top-centre of each tile's drawing, left to right. */
  tiles: Point[];
}

/**
 * Measures the desk once per layout change — one ResizeObserver, nothing on scroll or pointer, and
 * layout offsets rather than client rects, so the arrival animation's few pixels of rise don't
 * leave the connectors pointing below where each part comes to rest. `version` is whatever else
 * moves things: a different set of tiles.
 */
export function useDeskGeometry(
  stageRef: RefObject<HTMLElement | null>,
  mottoRef: RefObject<HTMLElement | null>,
  actionRef: RefObject<HTMLElement | null>,
  rowRef: RefObject<HTMLElement | null>,
  version: string,
): DeskGeometry | null {
  const [geometry, setGeometry] = useState<DeskGeometry | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const motto = mottoRef.current;
    const action = actionRef.current;
    const row = rowRef.current;
    if (!stage || !motto || !action || !row || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const at = (element: HTMLElement) => offsetWithin(element, stage);
      const m = at(motto);
      const a = at(action);
      // Each drop ends at its drawing's own selection frame — the way a connector meets a node — not at
      // the top of the swatch, which is empty canvas above a short drawing. A row with nothing in it
      // says so in words, and the connector ends at those instead.
      const tiles = [...row.querySelectorAll<HTMLElement>('.dc-starter-swatch, .dc-desk-empty')].map((target) => {
        const s = at(target);
        const frame = target.querySelector<HTMLElement>('.dc-chrome');
        return { x: Math.round(s.x + target.offsetWidth / 2), y: Math.round(s.y + (frame ? frame.offsetTop : 2)) };
      });
      const top = tiles.length > 0 ? Math.min(...tiles.map((tile) => tile.y)) : at(row).y;
      // The bus runs a short way under the label above the row, leaving the longer part of the gap to
      // the drops, so their arrowheads never crowd the bus; it clears both however tight the gap is.
      const labelBottom = at(row).y - (parseFloat(getComputedStyle(row).marginTop) || 0);
      const gap = Math.max(0, top - labelBottom);
      const next: DeskGeometry = {
        width: stage.clientWidth,
        height: stage.clientHeight,
        motto: { x: Math.round(m.x + motto.offsetWidth / 2), y: Math.round(m.y + motto.offsetHeight) },
        actionTop: { x: Math.round(a.x + action.offsetWidth / 2), y: Math.round(a.y) },
        actionBottom: { x: Math.round(a.x + action.offsetWidth / 2), y: Math.round(a.y + action.offsetHeight) },
        busY: Math.round(labelBottom + Math.min(14, gap * 0.4)),
        tiles,
      };
      setGeometry((current) => (current && same(current, next) ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(row);
    return () => observer.disconnect();
  }, [stageRef, mottoRef, actionRef, rowRef, version]);

  return geometry;
}

/** `element`'s top-left within `ancestor`, by layout alone — transforms don't move it. */
function offsetWithin(element: HTMLElement, ancestor: HTMLElement): Point {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

function same(a: DeskGeometry, b: DeskGeometry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
