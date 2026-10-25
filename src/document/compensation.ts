import type { DraftEdge } from './types';

const EMPTY_COMPENSATIONS: readonly DraftEdge[] = Object.freeze([]);
const visibleCache = new WeakMap<readonly DraftEdge[], readonly DraftEdge[]>();
const linkedCache = new WeakMap<readonly DraftEdge[], Map<string, readonly DraftEdge[]>>();
const collapsedCountCache = new WeakMap<readonly DraftEdge[], Map<string, number>>();

/** A generic call's free-text operation is not an HTTP verb. Preserve useful text as the
 * resource, while discarding the old generic "OK" placeholder when switching to HTTP. */
export function normalizeCompensationHttpLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  if (!trimmed || trimmed.toUpperCase() === 'OK') return undefined;
  if (/^(?:GET|POST|PUT|PATCH|DELETE)(?:\s|$)/i.test(trimmed)) return trimmed;
  return `POST ${trimmed}`;
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


/** Primitive selector for an edge's compact indicator, indexed once per array identity. */
export function collapsedCompensationCount(edges: readonly DraftEdge[], parentId: string): number {
  let counts = collapsedCountCache.get(edges);
  if (!counts) {
    counts = new Map();
    for (const edge of edges) {
      if (!isCollapsedCompensation(edge)) continue;
      const parent = edge.compensationFor!;
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    collapsedCountCache.set(edges, counts);
  }
  return counts.get(parentId) ?? 0;
}

/** Repair a missing/invalid link by leaving the action visible and independent. Never erase its details. */
export function repairCompensationLinks(edges: DraftEdge[]): DraftEdge[] {
  if (!edges.some((edge) => edge.compensationFor !== undefined || edge.compensationVisible !== undefined || (edge.semantic !== 'compensates' && (edge.compensationName !== undefined || edge.compensationProtocol !== undefined || edge.compensationDescription !== undefined)))) return edges;
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  let changed = false;
  const repaired = edges.map((edge) => {
    if (edge.semantic !== 'compensates' && edge.compensationFor === undefined && edge.compensationVisible === undefined && edge.compensationName === undefined && edge.compensationProtocol === undefined && edge.compensationDescription === undefined) return edge;
    const parent = edge.compensationFor ? byId.get(edge.compensationFor) : undefined;
    const valid = edge.semantic === 'compensates' && parent && parent !== edge && parent.semantic !== 'compensates';
    if (valid || (edge.semantic === 'compensates' && edge.compensationFor === undefined && edge.compensationVisible === undefined)) {
      if (edge.compensationProtocol !== 'http') return edge;
      const label = normalizeCompensationHttpLabel(edge.label);
      if (label === edge.label) return edge;
      changed = true;
      if (label === undefined) {
        const { label: _oldLabel, ...withoutLabel } = edge;
        return withoutLabel;
      }
      return { ...edge, label };
    }
    const { compensationFor: _link, compensationVisible: _visible, ...independent } = edge;
    if (edge.semantic !== 'compensates') {
      delete independent.compensationName;
      delete independent.compensationProtocol;
      delete independent.compensationDescription;
    }
    changed = true;
    return independent;
  });
  return changed ? repaired : edges;
}
