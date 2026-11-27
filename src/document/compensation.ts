import { cleanEdgeLabel } from './sanitize';
import type { DraftEdge } from './types';

const EMPTY_COMPENSATIONS: readonly DraftEdge[] = Object.freeze([]);
const visibleCache = new WeakMap<readonly DraftEdge[], readonly DraftEdge[]>();
const linkedCache = new WeakMap<readonly DraftEdge[], Map<string, readonly DraftEdge[]>>();

/** A generic call's free-text operation is not an HTTP verb. Preserve useful text as the
 * resource, while discarding the old generic "OK" placeholder when switching to HTTP. The verb is
 * kept within a label's limit, as a load keeps a label: past it, the next open would cut the end. */
export function normalizeCompensationHttpLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed || trimmed.toUpperCase() === 'OK') return undefined;
  if (/^(?:GET|POST|PUT|PATCH|DELETE)(?:\s|$)/i.test(trimmed)) return trimmed;
  return cleanEdgeLabel(`POST ${trimmed}`);
}

/** A linked compensation is an ordinary edge in the file, even while its line is folded away. */
export function isCollapsedCompensation(edge: DraftEdge): boolean {
  return edge.semantic === 'compensates' && edge.compensationFor !== undefined && edge.compensationVisible === false;
}

/** Stable filtered array for canvas and export planners; a file with no folded actions keeps its identity. */
export function visibleEdges(edges: readonly DraftEdge[]): readonly DraftEdge[] {
  const cached = visibleCache.get(edges);
  if (cached) return cached;
  const visible = edges.filter((edge) => !isCollapsedCompensation(edge));
  const result = visible.length === edges.length ? edges : visible;
  visibleCache.set(edges, result);
  return result;
}

/** Stable per-parent collection, indexed once per edges array rather than scanned per connector. */
export function linkedCompensations(edges: readonly DraftEdge[], parentId: string): readonly DraftEdge[] {
  let index = linkedCache.get(edges);
  if (!index) {
    const built = new Map<string, DraftEdge[]>();
    for (const edge of edges) {
      if (edge.semantic !== 'compensates' || !edge.compensationFor) continue;
      const list = built.get(edge.compensationFor);
      if (list) list.push(edge);
      else built.set(edge.compensationFor, [edge]);
    }
    index = built;
    linkedCache.set(edges, index);
  }
  return index.get(parentId) ?? EMPTY_COMPENSATIONS;
}

/** Whether the repair could change `edge`: a link to check, compensation details on a connector that
 *  is not an action, or an HTTP action whose operation may still need its verb. */
function mayNeedRepair(edge: DraftEdge): boolean {
  if (edge.compensationFor !== undefined || edge.compensationVisible !== undefined) return true;
  if (edge.semantic === 'compensates') return edge.compensationProtocol === 'http';
  return edge.compensationName !== undefined || edge.compensationProtocol !== undefined || edge.compensationDescription !== undefined;
}

/** An HTTP action names its operation with a verb, linked or not (`normalizeCompensationHttpLabel`). */
function withHttpOperation(edge: DraftEdge): DraftEdge {
  if (edge.semantic !== 'compensates' || edge.compensationProtocol !== 'http') return edge;
  const label = normalizeCompensationHttpLabel(edge.label);
  if (label === edge.label) return edge;
  if (label === undefined) {
    const { label: _oldLabel, ...withoutLabel } = edge;
    return withoutLabel;
  }
  return { ...edge, label };
}

/**
 * Repair a missing/invalid link by leaving the action visible and independent. Never erase its details.
 * One pass keeps what a second would, whatever else the room holds: a load runs it once, and the next
 * open has to keep what that one saved. It used to strip a broken link and leave the operation as it
 * was, and to skip an unlinked HTTP action unless another connector in the room was linked, so a label
 * changed on the second open, silently.
 */
export function repairCompensationLinks(edges: DraftEdge[]): DraftEdge[] {
  if (!edges.some(mayNeedRepair)) return edges;
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  let changed = false;
  const repaired = edges.map((edge) => {
    if (!mayNeedRepair(edge)) return edge;
    const parent = edge.compensationFor ? byId.get(edge.compensationFor) : undefined;
    const valid = edge.semantic === 'compensates' && parent && parent !== edge && parent.semantic !== 'compensates';
    const unlinked = edge.semantic === 'compensates' && edge.compensationFor === undefined && edge.compensationVisible === undefined;
    let kept = edge;
    if (!valid && !unlinked) {
      const { compensationFor: _link, compensationVisible: _visible, ...independent } = edge;
      if (edge.semantic !== 'compensates') {
        delete independent.compensationName;
        delete independent.compensationProtocol;
        delete independent.compensationDescription;
      }
      kept = independent;
    }
    // An action whose link was just removed is read as the unlinked action it now is.
    const next = withHttpOperation(kept);
    if (next !== edge) changed = true;
    return next;
  });
  return changed ? repaired : edges;
}

/** The business action names the recovery arrow; its HTTP or call operation remains editable
 * in the companion card. An unnamed action still shows that operation on the canvas,
 * and every export names it the same way. */
export function compensationDisplayLabel(edge: Pick<DraftEdge, 'compensationFor' | 'compensationName' | 'label'>): string | undefined {
  return edge.compensationFor && edge.compensationName?.trim() ? edge.compensationName.trim() : edge.label;
}
