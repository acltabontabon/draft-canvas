import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useReactFlow, useStore, useStoreApi } from '@xyflow/react';

export interface OverlayPoint {
  x: number;
  y: number;
}

export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlayFrame {
  /** A flow point → the page (client) point it's drawn at right now. */
  flowToScreenPosition: (point: OverlayPoint) => OverlayPoint;
  /** A page (client) point → a position inside the overlay the popover is portaled into. */
  screenToOverlay: (point: OverlayPoint) => OverlayPoint;
  /** The popover's own rendered size, in whole pixels (0×0 until first laid out). */
  size: OverlaySize;
}

export interface OverlayPlacement<P extends string> {
  transform: string;
  placement: P;
}

/**
 * Positions a canvas popover in screen space — portaled into React Flow's root, above every node
 * and outside the zoom, so it keeps its real size at every zoom level.
 *
 * Placement is written straight to the panel's `style.transform` (and `data-placement`) rather
 * than rendered: `place` runs after every render (the anchor moved, content changed), whenever the
 * viewport pans or zooms (a store subscription — no React render at all), and whenever the panel's
 * own size changes (a `ResizeObserver`, so no layout read per frame). Only a change of *side*
 * reaches React state, for the few things inside the panel that open away from the anchor.
 *
 * `place` returns null when there's nothing to anchor to; the panel is then left where it was.
 */
export function useOverlayPosition<P extends string>(
  panelRef: RefObject<HTMLElement | null>,
  initial: P,
  place: (frame: OverlayFrame, current: P) => OverlayPlacement<P> | null,
): { target: HTMLDivElement | null; placement: P } {
  const target = useStore((state) => state.domNode);
  const storeApi = useStoreApi();
  const { flowToScreenPosition } = useReactFlow();
  const [placement, setPlacement] = useState<P>(initial);
  const placementRef = useRef(placement);
  const placeRef = useRef(place);
  const sizeRef = useRef<OverlaySize>({ width: 0, height: 0 });
  const applyRef = useRef<() => void>(() => {});
  const observerRef = useRef<{ panel: HTMLElement; observer: ResizeObserver } | null>(null);

  useLayoutEffect(() => {
    placeRef.current = place;
    // The panel element only exists once the caller renders it, and can be swapped — (re)observe
    // whichever one is current. Content size re-places it: a section opening, a longer label.
    const current = panelRef.current;
    if (observerRef.current?.panel !== current) {
      observerRef.current?.observer.disconnect();
      observerRef.current = null;
      sizeRef.current = { width: 0, height: 0 };
      if (current && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(([entry]) => {
          const box = entry?.borderBoxSize?.[0];
          const width = Math.round(box ? box.inlineSize : current.offsetWidth);
          const height = Math.round(box ? box.blockSize : current.offsetHeight);
          if (width === sizeRef.current.width && height === sizeRef.current.height) return;
          sizeRef.current = { width, height };
          applyRef.current();
        });
        observer.observe(current);
        observerRef.current = { panel: current, observer };
      }
    }
    applyRef.current = () => {
      const panel = panelRef.current;
      const root = storeApi.getState().domNode;
      if (!panel || !root) return;
      if (sizeRef.current.width === 0) {
        sizeRef.current = { width: Math.round(panel.offsetWidth), height: Math.round(panel.offsetHeight) };
      }
      const rootRect = root.getBoundingClientRect();
      const result = placeRef.current(
        {
          flowToScreenPosition,
          screenToOverlay: (point) => ({ x: point.x - rootRect.left, y: point.y - rootRect.top }),
          size: sizeRef.current,
        },
        placementRef.current,
      );
      if (!result) return;
      if (panel.style.transform !== result.transform) panel.style.transform = result.transform;
      if (panel.dataset.placement !== result.placement) panel.dataset.placement = result.placement;
      if (result.placement !== placementRef.current) {
        placementRef.current = result.placement;
        setPlacement(result.placement);
      }
    };
    applyRef.current();
  });

  // Pan and zoom: follow the viewport without re-rendering anything.
  useEffect(() => {
    let last = storeApi.getState().transform;
    return storeApi.subscribe((state) => {
      if (state.transform === last) return;
      last = state.transform;
      applyRef.current();
    });
  }, [storeApi]);

  useEffect(
    () => () => {
      observerRef.current?.observer.disconnect();
      observerRef.current = null;
    },
    [],
  );

  return { target, placement };
}
