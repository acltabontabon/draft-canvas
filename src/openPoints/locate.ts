/**
 * Where a row in a review list points, and what to call it — the one lookup every "go to it" in the
 * product shares, so a connector two rooms down is named the same way wherever it is listed.
 *
 * Pure and framework-free, like the model it reads. Imports `document/` and `depth/` and nothing
 * else, so listing what a canvas holds never pulls in a renderer.
 */

import { displayNameFor } from '../document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { walkGraphs, type DepthPath } from '../depth/tree';

/** Where a row points, and what it is called. Both kinds resolve through the same navigation. */
export interface ElementTarget {
  kind: 'node' | 'edge';
  id: string;
  /** What to call it on screen — "Payment Service", or "Payment Service → Settlement Service". */
  label: string;
  /** Owner ids from the document outward-in; `[]` when it lives on the top-level canvas. */
  path: DepthPath;
  /** The name of the room it lives in, when that isn't the document itself. */
  room?: string;
}

function edgeLabel(edge: DraftEdge, nodes: Map<string, DraftNode>): string {
  const from = nodes.get(edge.source);
  const to = nodes.get(edge.target);
  // Matches how the command palette names a flow step, so a connector is called the same thing
  // wherever the product talks about one.
  return `${from ? displayNameFor(from) : '?'} → ${to ? displayNameFor(to) : '?'}`;
}

/**
 * An index of every element in the file, by id, with the room it lives in.
 *
 * Built once per read rather than per row: a 200-node file with 20 points would otherwise walk
 * every room 20 times over. Ids are unique file-wide (`validate.ts`), so one flat map is enough
 * and no target needs to carry a path of its own.
 */
export interface FileIndex {
  nodes: Map<string, { node: DraftNode; path: DepthPath; room?: string }>;
  edges: Map<string, { edge: DraftEdge; path: DepthPath; room?: string; label: string }>;
}

export function indexFile(file: DraftDocument): FileIndex {
  const index: FileIndex = { nodes: new Map(), edges: new Map() };
  // Room names come from the node that owns the room, so they are resolved against the *outer*
  // graph — which `walkGraphs` has already visited by the time it reaches the room itself.
  const ownerNames = new Map<string, string>();

  walkGraphs(file, (graph, path) => {
    const room = path.length === 0 ? undefined : ownerNames.get(path[path.length - 1]!);
    const here = new Map<string, DraftNode>();
    for (const node of graph.nodes) {
      here.set(node.id, node);
      ownerNames.set(node.id, displayNameFor(node));
      index.nodes.set(node.id, room === undefined ? { node, path } : { node, path, room });
    }
    for (const edge of graph.edges) {
      const label = edgeLabel(edge, here);
      index.edges.set(edge.id, room === undefined ? { edge, path, label } : { edge, path, room, label });
    }
  });

  return index;
}

/** The label, room and path for an element, or `undefined` if it no longer resolves. */
export function resolveTarget(index: FileIndex, kind: 'node' | 'edge', id: string): ElementTarget | undefined {
  if (kind === 'node') {
    const found = index.nodes.get(id);
    if (!found) return undefined;
    const target: ElementTarget = { kind: 'node', id, label: displayNameFor(found.node), path: found.path };
    if (found.room !== undefined) target.room = found.room;
    return target;
  }
  const found = index.edges.get(id);
  if (!found) return undefined;
  const target: ElementTarget = { kind: 'edge', id, label: found.label, path: found.path };
  if (found.room !== undefined) target.room = found.room;
  return target;
}
