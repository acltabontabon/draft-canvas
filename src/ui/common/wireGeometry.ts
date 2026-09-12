import { useLayoutEffect, useState, type RefObject } from 'react';

/** The measured positions a `Wire` needs: its own box, where the trunk leaves, where it arrives. */
export interface WireGeometry {
  width: number;
  height: number;
  trunkY: number;
  labelYs: number[];
}

/**
 * Measures the wire's own box, the source's middle, and the middle of every `targets` match
 * inside `stage`. Returns `null` while the wire is hidden (a narrow breakpoint), so the caller
 * renders nothing rather than a zero-width drawing.
 */
export function useWireGeometry(
  stageRef: RefObject<HTMLElement | null>,
  wireRef: RefObject<HTMLElement | null>,
  sourceRef: RefObject<HTMLElement | null>,
  targets: string,
): WireGeometry | null {
  const [geometry, setGeometry] = useState<WireGeometry | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const wire = wireRef.current;
    const source = sourceRef.current;
    if (!stage || !wire || !source || typeof ResizeObserver === 'undefined') return;
    // Layout offsets, not client rects: the arrival animation slides everything up a few pixels,
    // and a wire measured mid-slide would point just below where each target comes to rest.
    const middleOf = (element: HTMLElement) => topWithin(element, stage) + element.offsetHeight / 2;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = wire;
      // Hidden below the wide breakpoint: nothing to draw, nothing to keep.
      if (width === 0 || height === 0) {
        setGeometry((current) => (current === null ? current : null));
        return;
      }
      const top = topWithin(wire, stage);
      const labels = [...stage.querySelectorAll<HTMLElement>(targets)].map((label) =>
        Math.round(middleOf(label) - top),
      );
      const next: WireGeometry = { width, height, trunkY: Math.round(middleOf(source) - top), labelYs: labels };
      setGeometry((current) => (current && sameGeometry(current, next) ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(source);
    return () => observer.disconnect();
  }, [sourceRef, stageRef, targets, wireRef]);

  return geometry;
}

/** `element`'s top edge within `ancestor`, by layout alone — transforms don't move it. */
function topWithin(element: HTMLElement, ancestor: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

function sameGeometry(a: WireGeometry, b: WireGeometry): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.trunkY === b.trunkY &&
    a.labelYs.length === b.labelYs.length &&
    a.labelYs.every((y, i) => y === b.labelYs[i])
  );
}
