/**
 * Ordered interactions.
 *
 * Rather than a UML sequence-diagram engine, Draft Canvas lets any edge carry a
 * step number. The numbers are derived state kept contiguous from 1, so deleting
 * step 3 of 8 leaves a clean 1..7 instead of a hole. Explain Mode reads exactly
 * this list.
 */
import type { DraftDocument, DraftEdge } from './types';

export interface SequenceStep {
  edge: DraftEdge;
  index: number;
  sequence: number;
}

/** Edges that participate in the walkthrough, in step order. */
export function orderedEdges(doc: DraftDocument): DraftEdge[] {
  return doc.edges
    .filter((e) => typeof e.sequence === 'number')
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function sequenceSteps(doc: DraftDocument): SequenceStep[] {
  return orderedEdges(doc).map((edge, index) => ({
    edge,
    index,
    sequence: edge.sequence ?? index + 1,
  }));
}

/** Renumbers sequenced edges to 1..n while preserving their relative order. */
export function compactSequence(doc: DraftDocument): DraftDocument {
  const ordered = orderedEdges(doc);
  if (ordered.length === 0) {
    return doc.edges.some((e) => typeof e.sequence === 'number')
      ? { ...doc, edges: doc.edges.map(stripSequence) }
      : doc;
  }

  const target = new Map<string, number>();
  ordered.forEach((edge, index) => target.set(edge.id, index + 1));

  let changed = false;
  const edges = doc.edges.map((edge) => {
    const next = target.get(edge.id);
    if (next === undefined) return edge;
    if (edge.sequence === next) return edge;
    changed = true;
    return { ...edge, sequence: next };
  });
  return changed ? { ...doc, edges } : doc;
}

function stripSequence(edge: DraftEdge): DraftEdge {
  if (typeof edge.sequence !== 'number') return edge;
  const { sequence: _drop, ...rest } = edge;
  return rest;
}

/** Appends the edge to the end of the walkthrough. */
export function addToSequence(doc: DraftDocument, edgeId: string): DraftDocument {
  const target = doc.edges.find((e) => e.id === edgeId);
  if (!target || typeof target.sequence === 'number') return doc;
  const next = orderedEdges(doc).length + 1;
  return compactSequence({
    ...doc,
    edges: doc.edges.map((e) => (e.id === edgeId ? { ...e, sequence: next } : e)),
  });
}

export function removeFromSequence(doc: DraftDocument, edgeId: string): DraftDocument {
  const target = doc.edges.find((e) => e.id === edgeId);
  if (!target || typeof target.sequence !== 'number') return doc;
  return compactSequence({
    ...doc,
    edges: doc.edges.map((e) => (e.id === edgeId ? stripSequence(e) : e)),
  });
}

export function toggleSequence(doc: DraftDocument, edgeId: string): DraftDocument {
  const target = doc.edges.find((e) => e.id === edgeId);
  if (!target) return doc;
  return typeof target.sequence === 'number'
    ? removeFromSequence(doc, edgeId)
    : addToSequence(doc, edgeId);
}

/** Moves an edge one step earlier or later in the walkthrough. */
export function moveInSequence(
  doc: DraftDocument,
  edgeId: string,
  direction: -1 | 1,
): DraftDocument {
  const ordered = orderedEdges(doc);
  const from = ordered.findIndex((e) => e.id === edgeId);
  if (from === -1) return doc;
  const to = from + direction;
  if (to < 0 || to >= ordered.length) return doc;

  const reordered = [...ordered];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved!);

  const target = new Map<string, number>();
  reordered.forEach((edge, index) => target.set(edge.id, index + 1));
  return {
    ...doc,
    edges: doc.edges.map((edge) => {
      const next = target.get(edge.id);
      return next === undefined || edge.sequence === next ? edge : { ...edge, sequence: next };
    }),
  };
}

/** Numbers every edge in the document, in their current document order. */
export function sequenceAll(doc: DraftDocument): DraftDocument {
  if (doc.edges.length === 0) return doc;
  const ordered = orderedEdges(doc);
  const already = new Set(ordered.map((e) => e.id));
  let next = ordered.length;
  const edges = doc.edges.map((edge) => {
    if (already.has(edge.id)) return edge;
    next += 1;
    return { ...edge, sequence: next };
  });
  return compactSequence({ ...doc, edges });
}

export function clearSequence(doc: DraftDocument): DraftDocument {
  if (!doc.edges.some((e) => typeof e.sequence === 'number')) return doc;
  return { ...doc, edges: doc.edges.map(stripSequence) };
}
