/**
 * What changed in the architecture between two versions of a diagram, as statements about parts
 * and relations: a service was added, a call became asynchronous, a data store gained a user, a
 * relation now crosses a boundary.
 *
 * The history diff (`evolution/diff.ts`) says which elements and fields changed, including every
 * move and restyle. This reads the two architecture models instead, so a diagram rearranged from
 * top to bottom with nothing else touched says nothing here, and a single retyped connector says
 * exactly what it now means.
 *
 * Parts are matched by id. A part with no id match is matched by what it is, what it is called and
 * where it sits, when that is unambiguous on both sides: a diagram an agent drew again from
 * scratch has new ids throughout, and reading that as "everything removed, everything added"
 * would bury the one real change in it.
 */

import { labelOf, type ArchModel, type Boundary, type Entity, type Relation } from './model';

export type ArchChangeKind =
  | 'part-added'
  | 'part-removed'
  | 'part-renamed'
  | 'part-retyped'
  | 'technology-changed'
  | 'part-moved'
  | 'boundary-added'
  | 'boundary-removed'
  | 'boundary-retyped'
  | 'relation-added'
  | 'relation-removed'
  | 'relation-changed'
  | 'crossing-added'
  | 'crossing-removed';

export interface ArchChange {
  kind: ArchChangeKind;
  /** Ids in the later version (the earlier one for a removal), the one it is about first. */
  subjects: string[];
  /** One sentence, in the diagram's own names. */
  text: string;
}

const STORES = new Set<string>(['database', 'cache', 'fileSystem', 'objectStorage', 'searchIndex', 'queue', 'topic', 'stream', 'deadLetter']);

function quoted(part: Entity | Boundary | undefined, fallback: string): string {
  if (!part) return fallback;
  return part.name ? `"${part.name.length > 60 ? `${part.name.slice(0, 59)}…` : part.name}"` : labelOf(part);
}

function kindWord(entity: Entity): string {
  if (entity.kind && entity.kind !== 'generic') return entity.kind;
  return entity.category === 'generic' ? entity.type : entity.category;
}

/** What a part is, what it is called and where it sits: how two parts with different ids are told to be one. */
function signature(model: ArchModel, entity: Entity): string {
  const owners = entity.room.map((id) => model.entities.get(id)?.name.toLowerCase() ?? '?').join('/');
  return [entity.type, entity.name.trim().toLowerCase(), owners].join('\u0000');
}

/** Earlier id → later id for every part and boundary present in both. */
function matchParts(before: ArchModel, after: ArchModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of before.entities.keys()) if (after.entities.has(id)) map.set(id, id);
  for (const id of before.boundaries.keys()) if (after.boundaries.has(id)) map.set(id, id);

  const taken = new Set(map.values());
  const bucket = (model: ArchModel, skip: (id: string) => boolean) => {
    const groups = new Map<string, string[]>();
    for (const entity of model.entities.values()) {
      if (skip(entity.id) || !entity.name.trim()) continue;
      const key = signature(model, entity);
      const list = groups.get(key);
      if (list) list.push(entity.id);
      else groups.set(key, [entity.id]);
    }
    return groups;
  };
  const left = bucket(before, (id) => map.has(id));
  const right = bucket(after, (id) => taken.has(id));
  for (const [key, ids] of left) {
    const others = right.get(key);
    if (ids.length === 1 && others?.length === 1) map.set(ids[0]!, others[0]!);
  }

  const unnamedBoundary = (boundary: Boundary) => `${boundary.preset}\u0000${boundary.name.trim().toLowerCase()}\u0000${boundary.room.length}`;
  const leftBoundaries = new Map<string, string[]>();
  const rightBoundaries = new Map<string, string[]>();
  for (const boundary of before.boundaries.values()) if (!map.has(boundary.id) && boundary.name.trim()) push(leftBoundaries, unnamedBoundary(boundary), boundary.id);
  for (const boundary of after.boundaries.values()) if (!taken.has(boundary.id) && boundary.name.trim()) push(rightBoundaries, unnamedBoundary(boundary), boundary.id);
  for (const [key, ids] of leftBoundaries) {
    const others = rightBoundaries.get(key);
    if (ids.length === 1 && others?.length === 1) map.set(ids[0]!, others[0]!);
  }
  return map;
}

function push(groups: Map<string, string[]>, key: string, id: string): void {
  const list = groups.get(key);
  if (list) list.push(id);
  else groups.set(key, [id]);
}

function meaning(relation: Relation): string {
  const way = relation.async || relation.kind === 'async' || relation.kind === 'event' ? 'asynchronous' : relation.kind && relation.kind !== 'sync' ? relation.kind : 'synchronous';
  return `${relation.semantic ?? 'unspecified'}|${way}|${relation.directed ? 'directed' : 'plain'}`;
}

function isAsync(relation: Relation): boolean {
  return relation.async || relation.kind === 'async' || relation.kind === 'event';
}

/** The architecture's changes from `before` to `after`: parts first, then boundaries, then relations. */
export function architectureChanges(before: ArchModel, after: ArchModel): ArchChange[] {
  const out: ArchChange[] = [];
  const forward = matchParts(before, after);
  const backward = new Map([...forward].map(([was, now]) => [now, was]));
  const nameAfter = (id: string) => quoted(after.entities.get(id) ?? after.boundaries.get(id), id);
  const nameBefore = (id: string) => quoted(before.entities.get(id) ?? before.boundaries.get(id), id);

  for (const entity of after.entities.values()) {
    const wasId = backward.get(entity.id);
    const was = wasId ? before.entities.get(wasId) : undefined;
    if (!was) {
      out.push({ kind: 'part-added', subjects: [entity.id], text: `Added ${kindWord(entity)} ${nameAfter(entity.id)}${entity.technology ? ` (${entity.technology})` : ''}.` });
      continue;
    }
    if (was.name !== entity.name) out.push({ kind: 'part-renamed', subjects: [entity.id], text: `${nameBefore(was.id)} is now called ${nameAfter(entity.id)}.` });
    if (was.type !== entity.type || kindWord(was) !== kindWord(entity)) out.push({ kind: 'part-retyped', subjects: [entity.id], text: `${nameAfter(entity.id)} changed from ${kindWord(was)} to ${kindWord(entity)}.` });
    if ((was.technology ?? '') !== (entity.technology ?? '')) {
      out.push({ kind: 'technology-changed', subjects: [entity.id], text: `${nameAfter(entity.id)}: technology ${was.technology ? `changed from ${was.technology} to ${entity.technology ?? 'none'}` : `set to ${entity.technology}`}.` });
    }
    const boundariesWere = was.boundaries.map((id) => forward.get(id) ?? id);
    const left = boundariesWere.filter((id) => !entity.boundaries.includes(id));
    const entered = entity.boundaries.filter((id) => !boundariesWere.includes(id));
    const roomWas = was.room.map((id) => forward.get(id) ?? id).join('/');
    if (roomWas !== entity.room.join('/')) {
      out.push({ kind: 'part-moved', subjects: [entity.id], text: `${nameAfter(entity.id)} moved ${entity.room.length ? `inside ${nameAfter(entity.room[entity.room.length - 1]!)}` : 'to the top view'}.` });
    } else if (left.length || entered.length) {
      const parts = [entered.length ? `into ${entered.map(nameAfter).join(', ')}` : '', left.length ? `out of ${left.map((id) => (after.boundaries.has(id) ? nameAfter(id) : nameBefore(backward.get(id) ?? id))).join(', ')}` : ''].filter(Boolean);
      out.push({ kind: 'part-moved', subjects: [entity.id, ...entered, ...left], text: `${nameAfter(entity.id)} moved ${parts.join(' and ')}.` });
    }
  }
  for (const entity of before.entities.values()) {
    if (!forward.has(entity.id)) out.push({ kind: 'part-removed', subjects: [entity.id], text: `Removed ${kindWord(entity)} ${nameBefore(entity.id)}.` });
  }

  for (const boundary of after.boundaries.values()) {
    const wasId = backward.get(boundary.id);
    const was = wasId ? before.boundaries.get(wasId) : undefined;
    if (!was) out.push({ kind: 'boundary-added', subjects: [boundary.id], text: `Added ${boundary.preset === 'boundary' ? 'boundary' : `${boundary.preset} boundary`} ${nameAfter(boundary.id)}.` });
    else if (was.preset !== boundary.preset) out.push({ kind: 'boundary-retyped', subjects: [boundary.id], text: `${nameAfter(boundary.id)} changed from a ${was.preset} boundary to a ${boundary.preset} boundary.` });
  }
  for (const boundary of before.boundaries.values()) {
    if (!forward.has(boundary.id)) out.push({ kind: 'boundary-removed', subjects: [boundary.id], text: `Removed boundary ${nameBefore(boundary.id)}.` });
  }

  // Relations are told apart by their two ends, in the later version's ids. Several between the
  // same two parts are paired in order.
  const group = (relations: readonly Relation[], id: (end: string) => string | undefined) => {
    const groups = new Map<string, Relation[]>();
    for (const relation of relations) {
      const from = id(relation.from);
      const to = id(relation.to);
      if (!from || !to) continue;
      const list = groups.get(`${from}\u0000${to}`);
      if (list) list.push(relation);
      else groups.set(`${from}\u0000${to}`, [relation]);
    }
    return groups;
  };
  const were = group(before.relations, (end) => forward.get(end));
  const now = group(after.relations, (end) => end);
  const usersBefore = new Map<string, Set<string>>();
  for (const relation of before.relations) {
    const to = forward.get(relation.to);
    const from = forward.get(relation.from);
    if (to && from) usersBefore.set(to, (usersBefore.get(to) ?? new Set()).add(from));
  }

  for (const [key, list] of now) {
    const earlier = were.get(key) ?? [];
    list.forEach((relation, index) => {
      const was = earlier[index];
      const [from, to] = [relation.from, relation.to];
      if (!was) {
        const target = after.entities.get(to);
        const others = usersBefore.get(to);
        const shared = target && STORES.has(target.category) && backward.has(to) && others && others.size > 0 && !others.has(from) ? ` ${nameAfter(to)} now has ${others.size + 1} users.` : '';
        out.push({ kind: 'relation-added', subjects: [from, to, ...relation.edges], text: `${nameAfter(from)} now ${relation.directed ? 'has a relation to' : 'is related to'} ${nameAfter(to)}${relation.semantic ? ` (${relation.semantic}${isAsync(relation) ? ', asynchronous' : ''})` : ''}.${shared}` });
        if (relation.crosses.length) out.push({ kind: 'crossing-added', subjects: [from, to, ...relation.crosses], text: `The new relation from ${nameAfter(from)} to ${nameAfter(to)} crosses ${relation.crosses.map(nameAfter).join(', ')}.` });
        return;
      }
      if (meaning(was) !== meaning(relation)) {
        const said: string[] = [];
        if ((was.semantic ?? '') !== (relation.semantic ?? '')) said.push(`changed from ${was.semantic ?? 'unspecified'} to ${relation.semantic ?? 'unspecified'}`);
        if (isAsync(was) !== isAsync(relation)) said.push(isAsync(relation) ? 'became asynchronous' : 'became synchronous');
        if (was.directed !== relation.directed) said.push(relation.directed ? 'gained a direction' : 'lost its direction');
        if (said.length === 0) said.push(`is now ${relation.kind ?? 'a plain connector'}`);
        out.push({ kind: 'relation-changed', subjects: [from, to, ...relation.edges], text: `The relation from ${nameAfter(from)} to ${nameAfter(to)} ${said.join(' and ')}.` });
      }
      const crossedWere = was.crosses.map((id) => forward.get(id) ?? id);
      const gained = relation.crosses.filter((id) => !crossedWere.includes(id));
      const lost = crossedWere.filter((id) => !relation.crosses.includes(id));
      if (gained.length) out.push({ kind: 'crossing-added', subjects: [from, to, ...gained], text: `The relation from ${nameAfter(from)} to ${nameAfter(to)} now crosses ${gained.map(nameAfter).join(', ')}.` });
      if (lost.length) out.push({ kind: 'crossing-removed', subjects: [from, to], text: `The relation from ${nameAfter(from)} to ${nameAfter(to)} no longer crosses ${lost.length === 1 ? 'a boundary it did' : `${lost.length} boundaries it did`}.` });
    });
  }
  for (const [key, list] of were) {
    const later = now.get(key) ?? [];
    list.slice(later.length).forEach((relation) => {
      const from = forward.get(relation.from)!;
      const to = forward.get(relation.to)!;
      out.push({ kind: 'relation-removed', subjects: [from, to], text: `${nameAfter(from)} no longer has a relation to ${nameAfter(to)}${relation.semantic ? ` (${relation.semantic})` : ''}.` });
    });
  }
  // A relation that went with a removed part is said by the part's removal; one between two
  // surviving parts is said above.
  return out;
}
