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
 * - **Linked Junctions followed.** "Continues at A" is how a long connector is drawn in two
 *   halves: one ends at a Junction, the other starts at its counterpart, in the same view or in
 *   another. Here they are one relation, marked `linked`. This is the one reader that follows a
 *   link. Routing, flows, layout, connector semantics and the outage walk still do not
 *   (`junctions/`).
 *
 * What it never does: guess. A connector whose end can't be resolved to a part is listed in
 * `unread` with the reason, not dropped and not invented.
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
  /** It is drawn in two halves that meet at a linked Junction and its counterpart. */
  linked?: true;
  /** The view the far end is in, when a linked Junction carried it to another one. */
  toRoom?: DepthPath;
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
  /** It ends or starts at a linked Junction whose counterpart is not drawn yet, or leads nowhere:
   *  half a relation, waiting for the other half. Never an error. */
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
  byId: Map<string, DraftNode>;
  /** What leaves each Junction. */
  leaving: Map<string, DraftEdge[]>;
  chainOf: (node: DraftNode) => string[];
  /** Connectors that reached a linked Junction: where each carries on is decided across rooms. */
  tails: Tail[];
}

interface Tail {
  edge: DraftEdge;
  source: DraftNode;
  /** Connectors and Junctions on the way to the linked Junction, it included. */
  edges: string[];
  via: string[];
  last: DraftEdge;
  junction: DraftNode;
}

const isEnd = (node: DraftNode | undefined): node is DraftNode => !!node && (PART_TYPES.has(node.type) || node.type === 'group');

/** One relation, from the connector it starts with to the part it reaches. */
function relationOf(input: {
  from: RoomPart;
  to: RoomPart;
  source: DraftNode;
  end: DraftNode;
  edge: DraftEdge;
  last: DraftEdge;
  edges: string[];
  via: string[];
  split: boolean;
  linked: boolean;
}): Relation {
  const { edge, last, source, end } = input;
  // The first connector says what the relation is; one that says nothing leaves it to the last.
  const speaking = edge.semantic ? edge : last;
  const sourceChain = input.from.chainOf(source);
  const targetChain = input.to.chainOf(end);
  // In one view, a boundary is crossed when it holds one end and not the other. Across views
  // every boundary around either end is: the other end is not in that view at all.
  const crosses =
    input.from === input.to
      ? [...sourceChain.filter((id) => id !== end.id && !targetChain.includes(id)), ...targetChain.filter((id) => id !== source.id && !sourceChain.includes(id))]
      : [...sourceChain, ...targetChain];
  const kind = edge.kind ?? last.kind;
  const label = edge.label?.trim() || last.label?.trim();
  const condition = edge.condition?.trim() || last.condition?.trim();
  return {
    id: input.split ? `${edge.id}>${end.id}` : edge.id,
    room: input.from.path,
    from: source.id,
    to: end.id,
    edges: input.edges,
    via: input.via,
    split: input.split,
    ...(input.linked ? { linked: true as const } : {}),
    ...(input.from === input.to ? {} : { toRoom: input.to.path }),
    directed: edge.directed !== false && last.directed !== false,
    ...(speaking.semantic ? { semantic: speaking.semantic } : {}),
    stated: !!speaking.semantic && speaking.semanticsOrigin !== 'inferred',
    ...(kind ? { kind } : {}),
    async: !!(edge.async || last.async),
    ...(label ? { label } : {}),
    ...(condition ? { condition } : {}),
    crosses,
    evidence: last === edge ? (edge.evidence ?? []) : [...(edge.evidence ?? []), ...(last.evidence ?? [])],
  };
}

const roomCache = new WeakMap<readonly DraftNode[], RoomPart>();
const fileCache = new WeakMap<DraftDocument, ArchModel>();

/** The architecture `file` describes, across every room. The same file object answers from memory. */
export function modelOf(file: DraftDocument): ArchModel {
  const known = fileCache.get(file);
  if (known) return known;

  const entities = new Map<string, Entity>();
  const boundaries = new Map<string, Boundary>();
  const parts: RoomPart[] = [];
  for (const room of roomsOf(file)) {
    const part = readRoom(room.graph.nodes, room.graph.edges, room.path, effectiveLevel(file, room.path), room.owners[room.owners.length - 1]);
    for (const entity of part.entities) entities.set(entity.id, entity);
    for (const boundary of part.boundaries) boundaries.set(boundary.id, boundary);
    parts.push(part);
  }

  // Every linked Junction in the file, by its group: where a connector that reaches one carries on.
  const groups = new Map<string, { part: RoomPart; node: DraftNode }[]>();
  for (const part of parts) {
    for (const node of part.nodes) {
      if (node.type !== 'ellipse' || !node.link) continue;
      const list = groups.get(node.link);
      if (list) list.push({ part, node });
      else groups.set(node.link, [{ part, node }]);
    }
  }

  // Carry each connector that reached a linked Junction on from the Junction's counterparts,
  // through any further Junctions, to the parts it reaches there.
  const carried = new Map<RoomPart, Relation[]>();
  const fanned = new Set<string>();
  const walked = new Set<string>();
  const tooWide: Unread[] = [];
  if (groups.size > 0) {
    for (const part of parts) {
      const byEdge = new Map<string, { tail: Tail; ends: { end: DraftNode; part: RoomPart; edges: string[]; via: string[]; last: DraftEdge }[] }>();
      for (const tail of part.tails) {
        const found = byEdge.get(tail.edge.id) ?? { tail, ends: [] };
        byEdge.set(tail.edge.id, found);
        const seen = new Set<string>(tail.via);
        const queue: { part: RoomPart; junction: DraftNode; edges: string[]; via: string[]; last: DraftEdge }[] = [];
        const jump = (from: DraftNode, edges: string[], via: string[], last: DraftEdge) => {
          for (const other of groups.get(from.link!) ?? []) {
            if (other.node.id === from.id || seen.has(other.node.id)) continue;
            seen.add(other.node.id);
            queue.push({ part: other.part, junction: other.node, edges, via: [...via, other.node.id], last });
          }
        };
        jump(tail.junction, tail.edges, tail.via, tail.last);
        while (queue.length > 0 && found.ends.length <= MAX_FAN_OUT) {
          const at = queue.shift()!;
          for (const next of at.part.leaving.get(at.junction.id) ?? []) {
            const end = at.part.byId.get(next.target);
            if (!end) continue;
            const edges = [...at.edges, next.id];
            if (end.type !== 'ellipse') {
              if (isEnd(end) && end.id !== tail.source.id && !found.ends.some((hit) => hit.end.id === end.id)) found.ends.push({ end, part: at.part, edges, via: at.via, last: next });
              continue;
            }
            if (seen.has(end.id)) continue;
            seen.add(end.id);
            const via = [...at.via, end.id];
            queue.push({ part: at.part, junction: end, edges, via, last: next });
            if (end.link) jump(end, edges, via, next);
          }
        }
      }
      for (const { tail, ends } of byEdge.values()) {
        if (ends.length === 0) continue;
        if (ends.length > MAX_FAN_OUT) {
          tooWide.push({ edge: tail.edge.id, room: part.path, reason: 'fan-out' });
          continue;
        }
        const here = part.relations.filter((relation) => relation.edges[0] === tail.edge.id);
        const fresh = ends.filter((hit) => !here.some((relation) => relation.to === hit.end.id));
        const split = here.length + fresh.length > 1;
        if (split) fanned.add(tail.edge.id);
        const list = carried.get(part) ?? [];
        carried.set(part, list);
        for (const hit of fresh) {
          for (const id of hit.edges) walked.add(id);
          list.push(relationOf({ from: part, to: hit.part, source: tail.source, end: hit.end, edge: tail.edge, last: hit.last, edges: hit.edges, via: hit.via, split, linked: true }));
        }
      }
    }
  }

  const relations: Relation[] = [];
  const unread: Unread[] = [...tooWide];
  const rooms: RoomInfo[] = [];
  for (const part of parts) {
    const own = [
      // A connector a link carried further fans out after all: its relations are named for their ends.
      ...part.relations.map((relation) => (fanned.has(relation.edges[0]!) && !relation.split ? { ...relation, id: `${relation.edges[0]}>${relation.to}`, split: true } : relation)),
      ...(carried.get(part) ?? []),
    ];
    relations.push(...own);
    // Half a relation that found its other half is read; one still waiting stays listed.
    for (const entry of part.unread) if (entry.reason !== 'continued' || !walked.has(entry.edge)) unread.push(entry);
    rooms.push({
      path: part.path,
      ...(part.level ? { level: part.level } : {}),
      entities: part.entities.map((entity) => entity.id),
      boundaries: part.boundaries.map((boundary) => boundary.id),
      relations: own.map((relation) => relation.id),
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

  const relations: Relation[] = [];
  const unread: Unread[] = [];
  const tails: Tail[] = [];
  const part: RoomPart = { nodes, edges, level, owner, path, entities, boundaries, relations, unread, byId, leaving, chainOf, tails };

  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    // Validation drops a connector with a missing end; one arriving here some other way says nothing.
    if (!source || !target) continue;
    if (source.type === 'ellipse') {
      // Read from the connector that enters the Junction. One nothing enters has no beginning
      // here; a linked one may be given it by its counterpart (`modelOf`).
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
      const via = [...step.via, step.at.id];
      if (step.at.link) {
        continued = true;
        tails.push({ edge, source, edges: step.edges, via, last: step.last, junction: step.at });
      }
      const onward = leaving.get(step.at.id) ?? [];
      if (onward.length === 0 && !step.at.link) dangling = true;
      for (const next of onward) {
        const end = byId.get(next.target);
        if (end) pending.push({ at: end, edges: [...step.edges, next.id], via, last: next });
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
    for (const hit of reached) {
      if (hit.end.id === source.id) {
        if (!split) unread.push({ edge: edge.id, room: path, reason: 'self' });
        continue;
      }
      relations.push(relationOf({ from: part, to: part, source, end: hit.end, edge, last: hit.last, edges: hit.edges, via: hit.via, split, linked: false }));
    }
  }

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
