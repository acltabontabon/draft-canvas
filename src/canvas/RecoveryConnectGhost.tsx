import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { capabilityFor, categoryOf } from '../document/connectorSemantics';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';

type Point = { x: number; y: number };

/** A transient, canvas-space invitation to choose the destination of a new recovery call. */
export function RecoveryConnectGhost() {
  const gesture = useUiStore((state) => state.recoveryConnect);
  const nodes = useEditorStore((state) => state.document.nodes);
  const { screenToFlowPosition } = useReactFlow();
  const [pointer, setPointer] = useState<Point | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  useEffect(() => {
    if (!gesture) return;
    const onMove = (event: PointerEvent) => {
      setPointer(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__node') : null;
      setHoveredId(element?.dataset.id ?? null);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [gesture, screenToFlowPosition]);

  if (!gesture) return null;
  const source = nodes.find((node) => node.id === gesture.sourceNodeId);
  if (!source) return null;
  const candidate = nodes.find((node) => node.id === hoveredId);
  const target = candidate && candidate.id !== source.id &&
    capabilityFor(categoryOf(source), categoryOf(candidate))?.relations.includes('compensates')
      ? candidate
      : null;

  const center = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const toward = target
    ? { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    : pointer ?? { x: source.x + source.width + 120, y: center.y };
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const start = horizontal
    ? { x: center.x + Math.sign(dx || 1) * source.width / 2, y: center.y }
    : { x: center.x, y: center.y + Math.sign(dy || 1) * source.height / 2 };
  const end = target
    ? horizontal
      ? { x: toward.x - Math.sign(dx || 1) * target.width / 2, y: toward.y }
      : { x: toward.x, y: toward.y - Math.sign(dy || 1) * target.height / 2 }
    : toward;
  const bend = Math.max(28, Math.min(100, Math.abs(end.x - start.x) / 3));
  const path = horizontal
    ? `M${start.x},${start.y} C${start.x + Math.sign(dx || 1) * bend},${start.y} ${end.x - Math.sign(dx || 1) * bend},${end.y} ${end.x},${end.y}`
    : `M${start.x},${start.y} C${start.x},${start.y + Math.sign(dy || 1) * bend} ${end.x},${end.y - Math.sign(dy || 1) * bend} ${end.x},${end.y}`;

  return (
    <div className="dc-recovery-connect-ghost" aria-hidden="true">
      <svg className="dc-recovery-connect-surface" width="1" height="1" overflow="visible">
        <defs>
          <marker id="dc-recovery-connect-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M1 1 L7 4 L1 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        <path className="dc-recovery-connect-path" d={path} fill="none" markerEnd="url(#dc-recovery-connect-arrow)" />
        {target && <rect className="dc-recovery-connect-target" x={target.x - 5} y={target.y - 5} width={target.width + 10} height={target.height + 10} rx="10" />}
      </svg>
      <span className="dc-recovery-connect-prompt" style={{ transform: `translate(${end.x + 12}px, ${end.y + 15}px)` }}>
        {target ? `Use ${target.text || target.type}` : 'Choose a recovery target · Esc to cancel'}
      </span>
    </div>
  );
}
