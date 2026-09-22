import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';

/**
 * The dots under the pointer brighten, as if the canvas noticed you. A mouse-only nicety: two
 * custom properties written straight to the element at most once a frame, no React state, and
 * the stylesheet drops it entirely under reduced motion.
 */
export function useSpotlight(target: RefObject<HTMLElement | null>) {
  const frame = useRef<number | null>(null);
  const point = useRef({ x: 0, y: 0 });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return {
    move: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse') return;
      const rect = event.currentTarget.getBoundingClientRect();
      point.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const element = target.current;
        if (!element) return;
        element.style.setProperty('--x', `${point.current.x}px`);
        element.style.setProperty('--y', `${point.current.y}px`);
      });
    },
    leave: () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
  };
}
