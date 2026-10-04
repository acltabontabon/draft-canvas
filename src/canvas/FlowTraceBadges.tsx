import { useLayoutEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

/** Reads the already-rendered routes once per trace change, never once per connector or pan. */
export function FlowTraceBadges() {
  const trace = useUiStore((state) => state.flowTrace);
  const offset = useEditorStore((state) => state.document.flows.find((flow) => flow.id === trace?.flowId)?.steps.length ?? 0);
  const [points, setPoints] = useState<{ id: string; x: number; y: number }[]>([]);
  useLayoutEffect(() => {
    const next = (trace?.edgeIds ?? []).flatMap((id) => {
      const path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"] .dc-edge-hit`);
      if (!path) return [];
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      return [{ id, x: point.x, y: point.y }];
    });
    // The geometry belongs to the mounted SVG; it is unavailable during render.
    // oxlint-disable-next-line react/set-state-in-effect
    setPoints(next);
  }, [trace?.edgeIds]);
  return <div aria-hidden="true" className="dc-trace-badges">{points.map((point, index) => <span key={point.id} className="dc-trace-badge" style={{ transform: `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)` }}>{offset + index + 1}</span>)}</div>;
}
