/**
 * Where the camera goes when the history lens moves between revisions. Pure, like the rest of the
 * presentation framing (`framing.ts`): the lens asks, and moves only when told to.
 *
 * Calm by default: a change already in view keeps the camera still; one partly off screen is
 * nudged; only a change elsewhere is flown to, and never past a readable zoom. Orientation is kept —
 * the same `frameStep` that steps a presented flow decides.
 */
import type { Bounds } from '../document/geometry';
import type { DraftDocument, DraftNode, DraftViewport } from '../document/types';
import { frameStep, type Frame, type Insets, type View } from './framing';

function box(node: DraftNode): Bounds {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function union(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * The area of one room that differs between two versions: shapes added, removed, moved, resized or
 * changed, and the ends of connectors that came or went. `null` when nothing in the room differs.
 */
export function changedArea(before: DraftDocument | null, after: DraftDocument): Bounds | null {
  if (!before) return null;
  const was = new Map(before.nodes.map((node) => [node.id, node]));
  const now = new Map(after.nodes.map((node) => [node.id, node]));
  let area: Bounds | null = null;
  for (const node of after.nodes) {
    const old = was.get(node.id);
    if (!old) area = union(area, box(node));
    else if (old !== node && JSON.stringify({ ...old, inside: undefined }) !== JSON.stringify({ ...node, inside: undefined })) {
      area = union(union(area, box(node)), box(old));
    }
  }
  for (const node of before.nodes) if (!now.has(node.id)) area = union(area, box(node));
  const oldEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const newEdges = new Set(after.edges.map((edge) => edge.id));
  const ends = (source: string, target: string, nodes: Map<string, DraftNode>) => {
    for (const id of [source, target]) {
      const node = nodes.get(id);
      if (node) area = union(area, box(node));
    }
  };
  for (const edge of after.edges) {
    const old = oldEdges.get(edge.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(edge)) ends(edge.source, edge.target, now);
  }
  for (const edge of before.edges) if (!newEdges.has(edge.id)) ends(edge.source, edge.target, was);
  return area;
}

/** The camera for showing `after`, coming from `before`, or the same camera when it should stay. */
export function frameRevision(before: DraftDocument | null, after: DraftDocument, camera: DraftViewport, view: View, insets: Insets): Frame {
  const area = changedArea(before, after);
  if (!area) return { camera, kind: 'stay' };
  return frameStep(area, camera, view, insets);
}
