/**
 * The architecture a diagram describes, read out of the file: which parts there are, what each one
 * is, which boundary holds it and what connects to what. Derived, never stored. The file stays the
 * only source of truth; this is the one reading of it that checks, the headless CLI, impact
 * analysis and agents share, so none of them works the same things out a second way.
 *
 * What it adds to the raw file:
 *
 * - **Every room at once.** Analyses used to see one view. Here each part knows the room it is in
 *   and the shape that owns that room, so a part inside "Orders" can be traced back to it.
 * - **Junctions seen through.** A Junction is topology, not a part: `A → Junction → B` is one
 *   relation from A to B. A relation that fans out through one says so (`split`).
 * - **Boundaries as facts.** Each part carries the chain of boundaries around it, and each relation
 *   the boundaries it crosses.
 *
 * What it never does: guess. A connector whose end can't be resolved to a part is listed in
 * `unread` with the reason, not dropped and not invented. A Junction's `link` is not followed:
 * it is a way to travel, not a relationship (`junctions/`).
 *
 * Pure and deterministic, with no React, store or DOM. Rooms are remembered against the arrays they
 * were read from, so a drag or a restyle elsewhere costs nothing.
 */

import { categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { productOf } from '../document/technologyKind';
import type { BoundaryPreset, ConnectorKind, DraftDocument, DraftEdge, DraftNode, DraftNodeType, EdgeSemantic, SourceEvidence, ViewLevel } from '../document/types';
import { classify, systemBoundaryOf, type C4Classification } from '../depth/c4';
import { effectiveLevel } from '../depth/level';
import { roomsOf, type DepthPath } from '../depth/tree';

/** The shapes that are parts of an architecture. Notes, text, code, sequences and Junctions are not. */
const PART_TYPES: ReadonlySet<DraftNodeType> = new Set(['service', 'database', 'queue', 'actor', 'component', 'artifact']);

/** A relation fans out to at most this many parts through Junctions before the rest are left unread. */
export const MAX_FAN_OUT = 64;

export interface Entity {
  /** The shape's id: unique across the file, stable across edits, history and collaboration. */
  id: string;
  /** Owner ids from the document inward; `[]` at the top. */
  room: DepthPath;
  /** The shape whose inside this part is drawn in, if any. */
  owner?: string;
  /** First line of the shape's label, trimmed; empty when it has none. */
  name: string;
  type: DraftNodeType;
  /** The kind picked for the shape (`api`, `gateway`, `cache`, `topic`), when it has one. */
  kind?: string;
  /** What the capability matrix reads it as (`document/connectorSemantics.ts`). */
  category: NodeCategory;
  /** C4 role and scope, derived (`depth/c4.ts`). Absent where C4 has no element for the shape. */
  c4?: C4Classification;
  technology?: string;
  /** The single product `technology` names, lower case, or absent for none or a stack. */
  product?: string;
  description?: string;
  /** Instances drawn, when more than one. */
  replicas?: number;
  /** Boundaries around it in this room, innermost first. */
  boundaries: string[];
  /** It has a room of its own with parts in it. */
  hasInside: boolean;
  evidence: readonly SourceEvidence[];
}

export interface Boundary {
  id: string;
  room: DepthPath;
  name: string;
  preset: BoundaryPreset;
  /** The boundary this one sits in. */
  parent?: string;
}

export interface Relation {
  /** The connector's id, or `<connector>><target>` when a Junction fans it out to several parts. */
  id: string;
  room: DepthPath;
  /** Part or boundary ids. */
  from: string;
  to: string;
  /** Every connector on the way, the one it starts with first. */
  edges: string[];
  /** Junctions passed through. */
  via: string[];
  /** A Junction divided it: how much goes each way is not something the diagram says. */
  split: boolean;
  directed: boolean;
  semantic?: EdgeSemantic;
  /** `semantic` was chosen by the person, not inferred from the two ends. */
  stated: boolean;
  kind?: ConnectorKind;
  async: boolean;
  label?: string;
  condition?: string;
  /** Boundaries one end is inside and the other is not, innermost first. */
  crosses: string[];
  evidence: readonly SourceEvidence[];
}

export type UnreadReason =
  /** It ends at a Junction nothing leaves, or starts at one nothing enters. */
  | 'dangling-junction'
  /** It ends or starts at a linked Junction: it carries on where the Junction's counterpart is
   *  drawn. That is a way to travel, not a relationship, so nothing is read across it. */
  | 'continued'
  /** A Junction fans it out to more parts than are read. */
  | 'fan-out'
  /** One end is a note, text, code or sequence: annotation, not a relationship. */
  | 'annotation'
  /** It joins a shape to itself. */
  | 'self';

export interface Unread {
  edge: string;
  room: DepthPath;
  reason: UnreadReason;
}

export interface RoomInfo {
  path: DepthPath;
  /** The level the view has: its own, or the one it inherits. */
  level?: ViewLevel;
  entities: string[];
  boundaries: string[];
  relations: string[];
}

export interface ArchModel {
  entities: ReadonlyMap<string, Entity>;
  boundaries: ReadonlyMap<string, Boundary>;
  /** In room order, then connector order: the same file always gives the same list. */
  relations: readonly Relation[];
  rooms: readonly RoomInfo[];
  /** Connectors not read as a relation, and why. */
  unread: readonly Unread[];
}

interface RoomPart {
  nodes: readonly DraftNode[];
  edges: readonly DraftEdge[];
  level: ViewLevel | undefined;
  owner: DraftNode | undefined;
  path: DepthPath;
  entities: Entity[];
  boundaries: Boundary[];
  relations: Relation[];
  unread: Unread[];
}

const roomCache = new WeakMap<readonly DraftNode[], RoomPart>();
const fileCache = new WeakMap<DraftDocument, ArchModel>();

/** The architecture `file` describes, across every room. The same file object answers from memory. */
export function modelOf(file: DraftDocument): ArchModel {
  const known = fileCache.get(file);
  if (known) return known;

  const entities = new Map<string, Entity>();
  const boundaries = new Map<string, Boundary>();
  const relations: Relation[] = [];
  const unread: Unread[] = [];
  const rooms: RoomInfo[] = [];

  for (const room of roomsOf(file)) {
    const level = effectiveLevel(file, room.path);
    const owner = room.owners[room.owners.length - 1];
    const part = readRoom(room.graph.nodes, room.graph.edges, room.path, level, owner);
    for (const entity of part.entities) entities.set(entity.id, entity);
    for (const boundary of part.boundaries) boundaries.set(boundary.id, boundary);
    relations.push(...part.relations);
    unread.push(...part.unread);
    rooms.push({
      path: room.path,
      ...(level ? { level } : {}),
      entities: part.entities.map((entity) => entity.id),
      boundaries: part.boundaries.map((boundary) => boundary.id),
      relations: part.relations.map((relation) => relation.id),
    });
  }

  const model: ArchModel = { entities, boundaries, relations, rooms, unread };
  fileCache.set(file, model);
  return model;
}

function samePath(a: DepthPath, b: DepthPath): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function readRoom(nodes: readonly DraftNode[], edges: readonly DraftEdge[], path: DepthPath, level: ViewLevel | undefined, owner: DraftNode | undefined): RoomPart {
  const known = roomCache.get(nodes);
  if (known && known.edges === edges && known.level === level && known.owner === owner && samePath(known.path, path)) return known;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chains = new Map<string, string[]>();
  /** Boundaries around a shape, innermost first. A `parentId` ring ends where it repeats. */
  const chainOf = (node: DraftNode): string[] => {
    const cached = chains.get(node.id);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>([node.id]);
    for (let at = node.parentId; at && !seen.has(at); at = byId.get(at)?.parentId) {
      seen.add(at);
      if (byId.get(at)?.type === 'group') chain.push(at);
    }
    chains.set(node.id, chain);
    return chain;
  };

  const entities: Entity[] = [];
  const boundaries: Boundary[] = [];
  for (const node of nodes) {
    if (node.type === 'group') {
      const parent = chainOf(node)[0];
      boundaries.push({ id: node.id, room: path, name: nameOf(node), preset: node.boundaryPreset ?? 'boundary', ...(parent ? { parent } : {}) });
      continue;
    }
    if (!PART_TYPES.has(node.type)) continue;
    const systemBoundary = systemBoundaryOf(node, byId);
    const c4 = classify(node, { level, ...(owner ? { insideOwner: owner } : {}), ...(systemBoundary ? { systemBoundary } : {}) });
    const product = node.technology ? productOf(node.technology) : null;
    const kind = node.serviceKind ?? node.databaseKind ?? node.queueKind ?? node.actorKind ?? node.componentKind ?? node.artifactKind;
    entities.push({
      id: node.id,
      room: path,
      ...(owner ? { owner: owner.id } : {}),
      name: nameOf(node),
      type: node.type,
      ...(kind ? { kind } : {}),
      category: categoryOf(node),
      ...(c4 ? { c4 } : {}),
      ...(node.technology ? { technology: node.technology } : {}),
      ...(product ? { product } : {}),
      ...(node.description ? { description: node.description } : {}),
      ...(node.replicas && node.replicas > 1 ? { replicas: node.replicas } : {}),
      boundaries: chainOf(node),
      hasInside: (node.inside?.nodes.length ?? 0) > 0,
      evidence: node.evidence ?? [],
    });
  }

  // What leaves each Junction, built once: a relation that reaches one carries on along these.
  const leaving = new Map<string, DraftEdge[]>();
  const entering = new Set<string>();
  for (const edge of edges) {
    if (byId.get(edge.source)?.type === 'ellipse') {
      const list = leaving.get(edge.source);
      if (list) list.push(edge);
      else leaving.set(edge.source, [edge]);
    }
    if (byId.get(edge.target)?.type === 'ellipse') entering.add(edge.target);
  }

  const isEnd = (node: DraftNode | undefined): node is DraftNode => !!node && (PART_TYPES.has(node.type) || node.type === 'group');
  const relations: Relation[] = [];
  const unread: Unread[] = [];

  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    // Validation drops a connector with a missing end; one arriving here some other way says nothing.
    if (!source || !target) continue;
    if (source.type === 'ellipse') {
      // Read from the connector that enters the Junction. One nothing enters has no beginning.
      if (!entering.has(source.id)) unread.push({ edge: edge.id, room: path, reason: source.link ? 'continued' : 'dangling-junction' });
      continue;
    }
    if (!isEnd(source)) {
      unread.push({ edge: edge.id, room: path, reason: 'annotation' });
      continue;
    }

    // Walk on through any Junctions to every part the connector reaches.
    const reached: { end: DraftNode; edges: string[]; via: string[]; last: DraftEdge }[] = [];
    const visited = new Set<string>();
    const pending: { at: DraftNode; edges: string[]; via: string[]; last: DraftEdge }[] = [{ at: target, edges: [edge.id], via: [], last: edge }];
    let dangling = false;
    let continued = false;
    let annotation = false;
    while (pending.length > 0 && reached.length <= MAX_FAN_OUT) {
      const step = pending.shift()!;
      if (step.at.type !== 'ellipse') {
        if (isEnd(step.at)) reached.push({ end: step.at, edges: step.edges, via: step.via, last: step.last });
        else annotation = true;
        continue;
      }
      if (visited.has(step.at.id)) continue;
      visited.add(step.at.id);
      const onward = leaving.get(step.at.id) ?? [];
      if (onward.length === 0) {
        if (step.at.link) continued = true;
        else dangling = true;
      }
      for (const next of onward) {
        const end = byId.get(next.target);
        if (end) pending.push({ at: end, edges: [...step.edges, next.id], via: [...step.via, step.at.id], last: next });
      }
    }

    if (reached.length > MAX_FAN_OUT) {
      unread.push({ edge: edge.id, room: path, reason: 'fan-out' });
      continue;
    }
    if (reached.length === 0) {
      unread.push({ edge: edge.id, room: path, reason: dangling ? 'dangling-junction' : continued ? 'continued' : annotation ? 'annotation' : 'dangling-junction' });
      continue;
    }

    const split = reached.length > 1;
    const sourceChain = chainOf(source);
    for (const hit of reached) {
      if (hit.end.id === source.id) {
        if (!split) unread.push({ edge: edge.id, room: path, reason: 'self' });
        continue;
      }
      // The first connector says what the relation is; one that says nothing leaves it to the last.
      const speaking = edge.semantic ? edge : hit.last;
      const targetChain = chainOf(hit.end);
      const crosses = [
        ...sourceChain.filter((id) => id !== hit.end.id && !targetChain.includes(id)),
        ...targetChain.filter((id) => id !== source.id && !sourceChain.includes(id)),
      ];
      const kind = edge.kind ?? hit.last.kind;
      const label = edge.label?.trim() || hit.last.label?.trim();
      const condition = edge.condition?.trim() || hit.last.condition?.trim();
      const evidence = hit.last === edge ? (edge.evidence ?? []) : [...(edge.evidence ?? []), ...(hit.last.evidence ?? [])];
      relations.push({
        id: split ? `${edge.id}>${hit.end.id}` : edge.id,
        room: path,
        from: source.id,
        to: hit.end.id,
        edges: hit.edges,
        via: hit.via,
        split,
        directed: edge.directed !== false && hit.last.directed !== false,
        ...(speaking.semantic ? { semantic: speaking.semantic } : {}),
        stated: !!speaking.semantic && speaking.semanticsOrigin !== 'inferred',
        ...(kind ? { kind } : {}),
        async: !!(edge.async || hit.last.async),
        ...(label ? { label } : {}),
        ...(condition ? { condition } : {}),
        crosses,
        evidence,
      });
    }
  }

  const part: RoomPart = { nodes, edges, level, owner, path, entities, boundaries, relations, unread };
  roomCache.set(nodes, part);
  return part;
}

function nameOf(node: DraftNode): string {
  return node.text?.split('\n')[0]?.trim() ?? '';
}

/** What to call a part in a sentence: its name, or what it is when it has none. */
export function labelOf(entity: Entity | Boundary): string {
  if (entity.name) return entity.name;
  return 'preset' in entity ? `an unnamed ${entity.preset === 'boundary' ? 'boundary' : `${entity.preset} boundary`}` : `an unnamed ${entity.type}`;
}

/** The owners above a part, nearest first: the shapes whose insides it is drawn in. */
export function ownersOf(model: ArchModel, id: string): string[] {
  const room = model.entities.get(id)?.room ?? model.boundaries.get(id)?.room ?? [];
  return [...room].reverse();
}
