/**
 * Where everything in a file is, by id.
 *
 * Diffing, applying and repairing all start by asking "which room is this in", and walking the room
 * tree for each question would make a keystroke cost a scan per element. An index is built once per
 * file and cached by identity: the file a change was diffed *to* is the file the next change is
 * diffed *from*, so in steady state each commit indexes exactly one new file.
 */
import { walkGraphs, type DepthPath, type Graph } from '../depth/tree';
import type { DraftDocument, DraftEdge, DraftFlow, DraftInk, DraftNode, ViewLevel } from '../document/types';
import { ROOT_ROOM, type RoomId } from './changes';

export interface Located<T> {
  value: T;
  room: RoomId;
}

export interface IndexedRoom {
  path: DepthPath;
  graph: Graph & { level?: ViewLevel };
}

export interface FileIndex {
  nodes: Map<string, Located<DraftNode>>;
  edges: Map<string, Located<DraftEdge>>;
  flows: Map<string, Located<DraftFlow>>;
  ink: Map<string, Located<DraftInk>>;
  /** Every room that exists, by the id of its owner (`''` for the document). */
  rooms: Map<RoomId, IndexedRoom>;
}

const cache = new WeakMap<DraftDocument, FileIndex>();

export function indexOf(file: DraftDocument): FileIndex {
  const cached = cache.get(file);
  if (cached) return cached;
  const index: FileIndex = { nodes: new Map(), edges: new Map(), flows: new Map(), ink: new Map(), rooms: new Map() };
  walkGraphs(file, (graph, path) => {
    const room = path.length === 0 ? ROOT_ROOM : path[path.length - 1]!;
    index.rooms.set(room, { path, graph });
    for (const node of graph.nodes) index.nodes.set(node.id, { value: node, room });
    for (const edge of graph.edges) index.edges.set(edge.id, { value: edge, room });
    for (const flow of graph.flows) index.flows.set(flow.id, { value: flow, room });
    for (const stroke of graph.ink ?? []) index.ink.set(stroke.id, { value: stroke, room });
  });
  cache.set(file, index);
  return index;
}

/** The elements a change can name, by kind. */
export type ElementKind = 'node' | 'edge' | 'flow' | 'ink';

/** Where each element of one kind is. */
export function elementsOf(index: FileIndex, kind: ElementKind): Map<string, Located<{ id: string }>> {
  switch (kind) {
    case 'node':
      return index.nodes;
    case 'edge':
      return index.edges;
    case 'flow':
      return index.flows;
    case 'ink':
      return index.ink;
  }
}

/** The room collection an element kind lives in. */
export const COLLECTION_OF = { node: 'nodes', edge: 'edges', flow: 'flows', ink: 'ink' } as const;

const NONE: readonly { id: string }[] = Object.freeze([]);

/** A room's list for one collection — `ink` is absent from a room with none. */
export function itemsOf(graph: { nodes: { id: string }[]; edges: { id: string }[]; flows: { id: string }[]; ink?: { id: string }[] }, collection: 'nodes' | 'edges' | 'flows' | 'ink'): readonly { id: string }[] {
  return collection === 'ink' ? (graph.ink ?? NONE) : graph[collection];
}

/** The path to the room `room` names, or `undefined` when no such room — or owner — exists. */
export function pathOf(index: FileIndex, room: RoomId): DepthPath | undefined {
  if (room === ROOT_ROOM) return [];
  const existing = index.rooms.get(room);
  if (existing) return existing.path;
  // A shape with nothing inside it yet has no room, but it can be given one.
  const owner = index.nodes.get(room);
  if (!owner) return undefined;
  const parent = pathOf(index, owner.room);
  return parent && [...parent, room];
}
