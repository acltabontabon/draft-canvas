/**
 * What a presentation callout hangs from, in flow space — the marker its thread leaves (a
 * connector's chip row, a node's attachment badge), the thing it's about, and what it must keep
 * clear of. Screen conversion and placement happen later, per frame, in `PresentationCallout`.
 */
import { RAIL_LIFT, RAIL_SIZE } from '../../document/markerRail';
import type { DraftEdge, DraftNode } from '../../document/types';
import type { Rect } from '../../edges/routing';
import type { Box } from '../../presentation/calloutPlacement';
import {
  ATTACHMENT_ROW_GAP,
  edgeLabelPoint,
  rectOfInternal,
  type InternalNode,
} from '../edgeGeometry';

export interface FlowAnchor {
  kind: 'edge' | 'node';
  /** The marker's flow-space box, its rendered size measured from the DOM under `root` — or, while
   *  that element isn't there to measure, a fallback size (`measured: false`, so a caller caching
   *  the box knows to look again). */
  marker: (root: HTMLElement | null) => { box: Box; measured: boolean; below?: boolean };
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
/** An attachment tab that can't be measured: one rail mark at the shape's corner (`document/markerRail.ts`). */
const FALLBACK_TAB = { width: RAIL_SIZE, height: RAIL_SIZE };
const TAB_TOP = -(RAIL_SIZE + RAIL_LIFT);

/** Layout size in flow units — `offset*` ignores the viewport's scale transform, which is the point. */
function measured(element: HTMLElement | null | undefined): { width: number; height: number; measured: boolean } {
  return element && element.offsetWidth > 0
    ? { width: element.offsetWidth, height: element.offsetHeight, measured: true }
    : { ...FALLBACK_MARKER, measured: false };
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
  // The chip row sits beyond the connector's words (`edges/connectorMarks.ts`): under them beside an
  // upright run, under a caption (which hangs below its line), over a label above a level one. The
  // drawn row says exactly where, once it is mounted.
  const labelPoint = edgeLabelPoint(document, edge, sourceRect, targetRect, { own: true });
  const upright = labelPoint.side === 'left' || labelPoint.side === 'right';
  const preferBelow = upright || (edge.label ? labelPoint.side === 'bottom' : Boolean(edge.semantic));
  const box = (rect: Rect): Box => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  return {
    kind: 'edge',
    marker: (root) => {
      const row = root?.querySelector<HTMLElement>(`.dc-attachment-chip-row[data-host-id="${CSS.escape(edge.id)}"]`);
      const { width, height, measured: found } = measured(row);
      // Where `DraftEdgeView` pinned it (`attachmentRowTransform`), named on the row.
      const anchorX = Number(row?.dataset.anchorX);
      const anchorY = Number(row?.dataset.anchorY);
      if (row && Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
        const align = row.dataset.anchor;
        const x = align === 'start' ? anchorX : align === 'end' ? anchorX - width : anchorX - width / 2;
        return { box: { x, y: anchorY, width, height }, measured: found, below: row.dataset.flip === 'below' };
      }
      const y = preferBelow ? labelPoint.y + ATTACHMENT_ROW_GAP : labelPoint.y - ATTACHMENT_ROW_GAP - height;
      return { box: { x: labelPoint.x - width / 2, y, width, height }, measured: found };
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
      const { width, height, measured: found } = measured(badge);
      return found
        ? { box: { x: rect.x + badge!.offsetLeft, y: rect.y + badge!.offsetTop, width, height }, measured: true }
        : { box: { x: rect.x + rect.width - FALLBACK_TAB.width, y: rect.y + TAB_TOP, ...FALLBACK_TAB }, measured: false };
    },
    host,
    avoid: [host],
    preferBelow: false,
    exclude: [node.id],
  };
}
