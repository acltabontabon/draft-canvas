/**
 * What a presentation callout hangs from, in flow space — the marker its thread leaves (a
 * connector's chip row, a node's attachment badge), the thing it's about, and what it must keep
 * clear of. Screen conversion and placement happen later, per frame, in `PresentationCallout`.
 */
import type { DraftEdge, DraftNode } from '../../document/types';
import type { Rect } from '../../edges/routing';
import type { Box } from '../../presentation/calloutPlacement';
import {
  ATTACHMENT_ROW_GAP,
  attachmentRowBelowsSourceOrTarget,
  edgeLabelPoint,
  rectOfInternal,
  type InternalNode,
} from '../edgeGeometry';

export interface FlowAnchor {
  kind: 'edge' | 'node';
  /** The marker's flow-space box, its rendered size measured from the DOM under `root`. */
  marker: (root: HTMLElement | null) => Box;
  host: Box | null;
  /** Nodes the callout must never cover. */
  avoid: Box[];
  /** A connector's chip row hangs below its line. */
  preferBelow: boolean;
  /** Node ids the placement shouldn't also count as soft obstacles (already in `avoid`). */
  exclude: string[];
}

/** Rendered chip row / badge size when it can't be measured (not mounted yet, or culled). */
const FALLBACK_MARKER = { width: 44, height: 20 };
/** `.dc-attachment-badge` in `canvas.css`: `top: -22px; right: 6px`. */
const BADGE_TOP = -22;
const BADGE_RIGHT = 6;

/** Layout size in flow units — `offset*` ignores the viewport's scale transform, which is the point. */
function measured(element: HTMLElement | null | undefined): { width: number; height: number } {
  return element && element.offsetWidth > 0
    ? { width: element.offsetWidth, height: element.offsetHeight }
    : FALLBACK_MARKER;
}

export function edgeAnchor(
  document: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] },
  edge: DraftEdge,
  source: InternalNode | undefined,
  target: InternalNode | undefined,
): FlowAnchor | null {
  if (!source || !target) return null;
  const types = new Map(document.nodes.map((node) => [node.id, node.type]));
  const sourceRect = rectOfInternal(source, types.get(edge.source));
  const targetRect = rectOfInternal(target, types.get(edge.target));
  if (!sourceRect || !targetRect) return null;
  const labelPoint = edgeLabelPoint(document, edge, sourceRect, targetRect);
  const preferBelow = attachmentRowBelowsSourceOrTarget(labelPoint.x, labelPoint.y, sourceRect, targetRect);
  const box = (rect: Rect): Box => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  return {
    kind: 'edge',
    // Mirrors `attachmentRowTransform` in `DraftEdgeView`: centred on the label point, one gap off it.
    marker: (root) => {
      const row = root?.querySelector<HTMLElement>(`.dc-attachment-chip-row[data-host-id="${CSS.escape(edge.id)}"]`);
      const { width, height } = measured(row);
      const y = preferBelow ? labelPoint.y + ATTACHMENT_ROW_GAP : labelPoint.y - ATTACHMENT_ROW_GAP - height;
      return { x: labelPoint.x - width / 2, y, width, height };
    },
    host: null,
    avoid: [box(sourceRect), box(targetRect)],
    preferBelow,
    exclude: [edge.source, edge.target],
  };
}

export function nodeAnchor(node: InternalNode | undefined): FlowAnchor | null {
  const rect = node ? rectOfInternal(node) : null;
  if (!node || !rect) return null;
  const host: Box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  return {
    kind: 'node',
    marker: (root) => {
      const badge = root?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(node.id)}"] .dc-attachment-badge`,
      );
      const { width, height } = measured(badge);
      return badge && badge.offsetWidth > 0
        ? { x: rect.x + badge.offsetLeft, y: rect.y + badge.offsetTop, width, height }
        : { x: rect.x + rect.width - BADGE_RIGHT - width, y: rect.y + BADGE_TOP, width, height };
    },
    host,
    avoid: [host],
    preferBelow: false,
    exclude: [node.id],
  };
}
