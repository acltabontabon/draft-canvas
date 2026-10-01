/**
 * What the architecture source formats (`mermaidFlowchart.ts`, `c4plantuml.ts`, `structurizr.ts`,
 * `drawio.ts`) have in common: the walk over every room, one identifier per element that is unique
 * across the whole output, the caption a connector carries, and the boundary tree a room's
 * `parentId`s describe. Pure functions over the document model — nothing here formats text for any
 * one target, so a generator can never pick up another's escaping by accident.
 */

import { edgeRelationLabel } from '../../document/connectorSemantics';
import { displayNameFor } from '../../document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../../document/types';
import { aliasFor } from '../../sequence/alias';
import { collectRooms, roomTitleFor, type ExportRoom } from '../rooms';

export { collectRooms, roomTitleFor, type ExportRoom };

/** The shapes that stand for a piece of architecture — what every format exports as an element. */
export function isArchitecture(node: DraftNode): boolean {
  return node.type === 'service' || node.type === 'database' || node.type === 'queue' || node.type === 'actor' || node.type === 'component';
}

export function isBoundary(node: DraftNode): boolean {
  return node.type === 'group';
}

/** A single line, trimmed — every target format declares names on one line. */
export function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\r\n?|\n/g, ' ').replace(/\s+/g, ' ').trim();
}

export function nameOf(node: DraftNode): string {
  return oneLine(displayNameFor(node)) || 'Element';
}

/**
 * The words on a connector: its own label when it has one, otherwise the relationship its semantic
 * reads as on the canvas ("reads from", "publishes to") — the same caption `edges/describe.ts`
 * draws, so the source never says something the picture does not.
 */
export function edgeCaption(graph: Pick<DraftDocument, 'nodes'>, edge: DraftEdge): string {
  const own = oneLine(edge.label);
  if (own) return own;
  return oneLine(edgeRelationLabel(graph, edge));
}

/** The protocol a semantic names, when it names one — what C4 and Structurizr call "technology". */
export function edgeTechnology(edge: DraftEdge): string | undefined {
  if (edge.semantic === 'http') return 'HTTP';
  if (edge.semantic === 'grpc') return 'gRPC';
  return undefined;
}

/**
 * One identifier per node, unique across every room of the document, so a format that flattens
 * rooms into one namespace (Mermaid, Structurizr) never declares the same id twice. Readable
 * slugs via `aliasFor`; the fallback is positional (`N7`) rather than the node's own id, which can
 * hold characters no target accepts. `reserved` adds the words a format cannot take as a bare
 * identifier beyond the sequence-diagram set `aliasFor` already knows.
 */
export function aliasTable(rooms: readonly ExportRoom[], reserved: ReadonlySet<string> = new Set()): Map<string, string> {
  const taken = new Set<string>();
  const aliases = new Map<string, string>();
  let n = 0;
  for (const room of rooms) {
    for (const node of room.document.nodes) {
      n += 1;
      const fallback = `N${n}`;
      const slug = aliasFor(nameOf(node), fallback, taken);
      // A format's own keywords are matched without case, so "Style" can't slip past "style"; an
      // empty label slugs to nothing, which `aliasFor` already answers with the fallback.
      const alias = reserved.has(slug.toLowerCase()) ? aliasFor('', fallback, taken) : slug;
      taken.add(alias);
      aliases.set(node.id, alias);
    }
  }
  return aliases;
}

export interface BoundaryTree {
  /** Nodes with no boundary around them (or whose boundary is not in this graph), in document order. */
  roots: DraftNode[];
  /** A boundary's direct members, in document order. Empty for a node that is not a boundary. */
  childrenOf: (boundary: DraftNode) => DraftNode[];
}

/**
 * The containment a room's `parentId`s describe, with any dangling parent treated as none —
 * `validate.ts` repairs those on read, so this is belt-and-braces, never the place that decides.
 * Only a boundary can contain; a `parentId` naming any other shape reads as top-level.
 */
export function boundaryTree(nodes: readonly DraftNode[]): BoundaryTree {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, DraftNode[]>();
  const roots: DraftNode[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && isBoundary(parent) && parent.id !== node.id) {
      const list = children.get(parent.id) ?? [];
      list.push(node);
      children.set(parent.id, list);
    } else {
      roots.push(node);
    }
  }
  return { roots, childrenOf: (boundary) => children.get(boundary.id) ?? [] };
}

/** Both ends present and exported — a connector to a shape a format leaves out is left out too. */
export function edgesBetween(graph: Pick<DraftDocument, 'edges'>, exported: ReadonlySet<string>): DraftEdge[] {
  return graph.edges.filter((edge) => exported.has(edge.source) && exported.has(edge.target));
}

/** The document's title, on one line, for the header comment every format opens with. */
export function titleOf(document: DraftDocument): string {
  return oneLine(document.metadata.title) || 'Canvas';
}
