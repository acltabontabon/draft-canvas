import { useLayoutEffect, useState } from 'react';
import { useStore as useReactFlowStore } from '@xyflow/react';
import type { DraftEdge, DraftNode } from '../../document/types';
import { useEditorStore } from '../../store/editorStore';
import type { ReplyPoint } from '../companion';

/**
 * The numbers of Nodi's reply pinned onto the parts each point is about, so an answer about the
 * diagram is read on the diagram: hovering a pin lights its point in the bubble (and the bubble's
 * point lights the pin and its parts), clicking one opens the conversation at that point. Screen-space
 * buttons over the canvas, like the proposal chip; nothing here touches the document.
 */

/** Where a pin stands, in flow coordinates. */
interface Spot {
  x: number;
  y: number;
}

/** Pins sharing a part sit side by side, this far apart (screen px). */
const PIN_STEP = 24;

/** A shape's pin: on its top-left shoulder, clear of the open-point marker on the top-right. */
function nodeSpot(node: DraftNode): Spot {
  return { x: node.x - 4, y: node.y - 4 };
}

/**
 * A connector's pin: just before its label, as the canvas drew it, or at its line's midpoint when it
 * has none. Read from the DOM: the label's place comes out of the routing the view did, which nothing
 * outside the view keeps.
 */
function edgeSpot(id: string, transform: [number, number, number]): Spot | null {
  const [tx, ty, zoom] = transform;
  const escaped = CSS.escape(id);
  const label = document.querySelector<HTMLElement>(`[data-edge-overlay="${escaped}"] .dc-edge-label`);
  const pane = label?.closest('.react-flow');
  if (label && pane) {
    const box = label.getBoundingClientRect();
    const origin = pane.getBoundingClientRect();
    return { x: (box.left - origin.left - tx) / zoom - 12 / zoom, y: (box.top + box.height / 2 - origin.top - ty) / zoom };
  }
  const line = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${escaped}"] path.dc-edge-line`);
  if (!line) return null;
  const point = line.getPointAtLength(line.getTotalLength() / 2);
  return { x: point.x, y: point.y };
}

function spotsOf(points: readonly ReplyPoint[], nodes: readonly DraftNode[], edges: readonly DraftEdge[], transform: [number, number, number]) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgeIds = new Set(edges.map((e) => e.id));
  const spots = new Map<number, Spot & { slot: number }>();
  const taken = new Map<string, number>();
  for (const { point, parts } of points) {
    for (const part of parts) {
      const node = nodeById.get(part);
      const spot = node ? nodeSpot(node) : edgeIds.has(part) ? edgeSpot(part, transform) : null;
      if (!spot) continue;
      const slot = taken.get(part) ?? 0;
      taken.set(part, slot + 1);
      spots.set(point, { ...spot, slot });
      break;
    }
  }
  return spots;
}

export function PointPins({
  points,
  hot,
  names,
  onHot,
  onOpen,
}: {
  points: readonly ReplyPoint[];
  hot: number | null;
  names: ReadonlyMap<string, string>;
  onHot: (point: number | null) => void;
  onOpen: (point: number) => void;
}) {
  const nodes = useEditorStore((state) => state.document.nodes);
  const edges = useEditorStore((state) => state.document.edges);
  const tx = useReactFlowStore((state) => state.transform[0]);
  const ty = useReactFlowStore((state) => state.transform[1]);
  const zoom = useReactFlowStore((state) => state.transform[2]);
  const [spots, setSpots] = useState<ReturnType<typeof spotsOf>>(() => new Map());

  // Measured in flow coordinates, so panning and zooming only move them. Again on the next frame: a
  // connector's label lands once the view has routed it.
  useLayoutEffect(() => {
    const transform: [number, number, number] = [tx, ty, zoom];
    setSpots(spotsOf(points, nodes, edges, transform));
    const frame = requestAnimationFrame(() => setSpots(spotsOf(points, nodes, edges, transform)));
    return () => cancelAnimationFrame(frame);
    // The transform at measuring time only converts the label's screen box; a later pan needs no new
    // measurement, so it is left out on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, nodes, edges]);

  return (
    <>
      {points.map(({ point, parts }, index) => {
        const spot = spots.get(point);
        if (!spot) return null;
        const about = parts.map((id) => names.get(id) ?? id).join(', ');
        return (
          <button
            key={point}
            type="button"
            className="dc-companion-pin"
            data-hot={hot === point ? 'true' : undefined}
            style={{ left: spot.x * zoom + tx + spot.slot * PIN_STEP, top: spot.y * zoom + ty, animationDelay: `${index * 60}ms` }}
            aria-label={`Point ${point}, about ${about}`}
            title={about}
            onMouseEnter={() => onHot(point)}
            onMouseLeave={() => onHot(null)}
            onFocus={() => onHot(point)}
            onBlur={() => onHot(null)}
            onClick={() => onOpen(point)}
          >
            {point}
          </button>
        );
      })}
    </>
  );
}
