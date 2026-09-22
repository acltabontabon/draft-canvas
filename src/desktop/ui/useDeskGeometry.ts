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
  /** Where the bus runs, just above the row. */
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
      const tiles = [...row.querySelectorAll<HTMLElement>('.dc-starter-swatch')].map((swatch) => {
        const s = at(swatch);
        // The drawing sits 4px down in its swatch; the arrow stops just above it.
        return { x: Math.round(s.x + swatch.offsetWidth / 2), y: Math.round(s.y + 2) };
      });
      const top = tiles.length > 0 ? Math.min(...tiles.map((tile) => tile.y)) : at(row).y;
      const next: DeskGeometry = {
        width: stage.clientWidth,
        height: stage.clientHeight,
        motto: { x: Math.round(m.x + motto.offsetWidth / 2), y: Math.round(m.y + motto.offsetHeight) },
        actionTop: { x: Math.round(a.x + action.offsetWidth / 2), y: Math.round(a.y) },
        actionBottom: { x: Math.round(a.x + action.offsetWidth / 2), y: Math.round(a.y + action.offsetHeight) },
        busY: top - 22,
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
