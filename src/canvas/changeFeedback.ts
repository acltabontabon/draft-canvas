import type { DraftDocument } from '../document/types';
import type { HistoryState } from '../history/HistoryStack';

/**
 * What one document change did to the canvas, so the canvas can show it: shapes and connectors that
 * arrive settle in or draw themselves, ones that leave fade where they stood, and an undo or redo
 * points at what it put back. Pure, so it can be tested without a canvas.
 *
 * Read only from consecutive store states of the same room of the same file. Opening another
 * diagram or stepping into a shape replaces everything on screen, which is not a change to show.
 */
export interface CanvasChange {
  arrivedNodes: string[];
  arrivedEdges: string[];
  departedNodes: string[];
  departedEdges: string[];
  /** Undo or redo only: shapes that stayed but moved — they glide back rather than jump. */
  movedNodes: string[];
  /** Undo or redo only: elements that stayed in place but changed (a label, a colour, a size). */
  changedNodes: string[];
  changedEdges: string[];
}

/**
 * Above this many elements arriving or leaving at once (a large paste, an import), the change is
 * simply made: animating hundreds of shapes is a cost with nothing to read in it.
 */
export const CHANGE_FEEDBACK_LIMIT = 80;

export type HistoryStep = 'undo' | 'redo' | null;

/** Whether `next` is `prev` with one undo or one redo applied — the entry moved between stacks. */
export function historyStep(prev: HistoryState, next: HistoryState): HistoryStep {
  if (prev === next) return null;
  const undone = prev.past.at(-1);
  if (undone && next.future[0] === undone && next.future.length === prev.future.length + 1) return 'undo';
  const redone = prev.future[0];
  if (redone && next.past.at(-1) === redone && next.future.length === prev.future.length - 1) return 'redo';
  return null;
}

type Graph = Pick<DraftDocument, 'nodes' | 'edges'>;

/**
 * The change from `prev` to `next`, or null when there is nothing to show. Cheap for the common
 * case — a drag rewrites node positions every frame, keeping every id in place — which returns
 * after one allocation-free pass, before building any index.
 */
export function canvasChange(prev: Graph, next: Graph, step: HistoryStep): CanvasChange | null {
  if (prev.nodes === next.nodes && prev.edges === next.edges) return null;
  if (step === null && sameIds(prev.nodes, next.nodes) && sameIds(prev.edges, next.edges)) return null;

  const change: CanvasChange = {
    arrivedNodes: [],
    arrivedEdges: [],
    departedNodes: [],
    departedEdges: [],
    movedNodes: [],
    changedNodes: [],
    changedEdges: [],
  };

  const prevNodes = new Map(prev.nodes.map((node) => [node.id, node]));
  const nextNodeIds = new Set<string>();
  for (const node of next.nodes) {
    nextNodeIds.add(node.id);
    const was = prevNodes.get(node.id);
    if (!was) change.arrivedNodes.push(node.id);
    else if (step !== null && was !== node) {
      // Unchanged elements keep their identity across snapshots (`HistoryStack.ts`), so a new
      // object is one this step touched.
      if (was.x !== node.x || was.y !== node.y) change.movedNodes.push(node.id);
      else change.changedNodes.push(node.id);
    }
  }
  for (const node of prev.nodes) if (!nextNodeIds.has(node.id)) change.departedNodes.push(node.id);

  const prevEdges = new Map(prev.edges.map((edge) => [edge.id, edge]));
  const nextEdgeIds = new Set<string>();
  for (const edge of next.edges) {
    nextEdgeIds.add(edge.id);
    const was = prevEdges.get(edge.id);
    if (!was) change.arrivedEdges.push(edge.id);
    else if (step !== null && was !== edge && !sameRouteOnly(was, edge)) change.changedEdges.push(edge.id);
  }
  for (const edge of prev.edges) if (!nextEdgeIds.has(edge.id)) change.departedEdges.push(edge.id);

  const total =
    change.arrivedNodes.length + change.arrivedEdges.length + change.departedNodes.length + change.departedEdges.length;
  if (total > CHANGE_FEEDBACK_LIMIT) return null;
  if (change.changedNodes.length + change.changedEdges.length + change.movedNodes.length > CHANGE_FEEDBACK_LIMIT) {
    change.changedNodes = [];
    change.changedEdges = [];
    change.movedNodes = [];
  }
  const empty =
    total === 0 && change.movedNodes.length === 0 && change.changedNodes.length === 0 && change.changedEdges.length === 0;
  return empty ? null : change;
}

/** The same elements in the same order — one pass, no allocation, cheap enough for every drag frame. */
function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}

/**
 * A connector whose only difference is its stored bends follows a shape that moved; the shape's
 * glide already says what happened, and a pulse along the line as well would be noise.
 */
function sameRouteOnly(a: object, b: object): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'waypoints') continue;
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}
