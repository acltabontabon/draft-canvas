import { useMemo } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';

export interface OverlayPoint {
  x: number;
  y: number;
}

export interface CanvasOverlay {
  /** The React Flow root the popovers portal into — above the nodes and edges, outside the zoom. */
  target: HTMLDivElement | null;
  /** A page (client) point → a position inside `target`. */
  screenToOverlay: (point: OverlayPoint) => OverlayPoint;
}

/**
 * Where canvas popovers live: in screen space, not flow space.
 *
 * They used to render through `ViewportPortal`, inside the zoomed viewport — so at 25% zoom their
 * 12px controls rendered at 3px, at 400% one covered the screen, and a selected or raised node
 * (whose z-index climbs with `elevateNodesOnSelect` and "Bring to front") painted over them. Placed
 * in React Flow's root instead, a popover stays its real size at every zoom, sits above every node,
 * and — because this subscribes to the viewport transform — re-places itself as the canvas pans.
 */
export function useCanvasOverlay(): CanvasOverlay {
  const tx = useStore((state) => state.transform[0]);
  const ty = useStore((state) => state.transform[1]);
  const zoom = useStore((state) => state.transform[2]);
  const target = useStore((state) => state.domNode);
  const { flowToScreenPosition } = useReactFlow();
  return useMemo(() => {
    // `flowToScreenPosition` of the flow origin is the root's page offset plus the pan — no
    // layout read of our own needed to go from page coordinates to root-relative ones.
    const origin = flowToScreenPosition({ x: 0, y: 0 });
    const left = origin.x - tx;
    const top = origin.y - ty;
    return {
      target,
      screenToOverlay: (point) => ({ x: point.x - left, y: point.y - top }),
    };
    // `zoom` isn't read here, but a zoom moves every anchor, so it must refresh the projection.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [flowToScreenPosition, target, tx, ty, zoom]);
}
