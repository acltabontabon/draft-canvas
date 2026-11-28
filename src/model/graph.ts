/**
 * Questions asked of the architecture model as a graph: what a part reaches, what reaches it,
 * where the loops are, what crosses a boundary and what several parts share.
 *
 * Everything here follows the arrows as drawn. That is where work goes, which is not always what
 * depends on what: a Queue's arrow points at the Worker that depends on it. Reading dependency and
 * failure from the relationships is the outage walk's job (`traffic/outage.ts`); this module never
 * claims more than "drawn as reaching".
 *
 * Bounded and deterministic: every walk has a limit and says when it stopped at it.
 */

import type { ArchModel, Relation } from './model';
import { compareText, stronglyConnected } from './scc';

/** A walk gives up after this many parts and says so. The file cap is 5,000 shapes. */
export const REACH_LIMIT = 5000;

export interface Reach {
  /** Parts and boundaries reached, nearest first, without the one the walk started from. */
  ids: string[];
  /** The relations walked along. */
  relations: string[];
  /** How many relations away each reached part is. */
  distance: Record<string, number>;
  /** It stopped at the limit: there may be more. */
  truncated: boolean;
}

export type RelationFilter = (relation: Relation) => boolean;

function walk(model: ArchModel, start: string, forward: boolean, filter: RelationFilter | undefined, limit: number): Reach {
  const next = new Map<string, { relation: Relation; end: string }[]>();
  const add = (from: string, relation: Relation, end: string) => {
    const list = next.get(from);
    if (list) list.push({ relation, end });
    else next.set(from, [{ relation, end }]);
  };
  for (const relation of model.relations) {
    if (filter && !filter(relation)) continue;
    if (forward) add(relation.from, relation, relation.to);
    else add(relation.to, relation, relation.from);
    // A line with no arrow says the two are related, not which way: it is walked both ways.
    if (!relation.directed) {
      if (forward) add(relation.to, relation, relation.from);
      else add(relation.from, relation, relation.to);
    }
  }

  const distance: Record<string, number> = {};
  const ids: string[] = [];
  const relations = new Set<string>();
  const seen = new Set<string>([start]);
  let frontier = [start];
  let depth = 0;
  let truncated = false;
  while (frontier.length > 0 && !truncated) {
    depth += 1;
    const following: string[] = [];
    walking: for (const at of frontier) {
      for (const { relation, end } of next.get(at) ?? []) {
        relations.add(relation.id);
        if (seen.has(end)) continue;
        if (ids.length >= limit) {
          truncated = true;
          break walking;
        }
        seen.add(end);
        ids.push(end);
        distance[end] = depth;
        following.push(end);
      }
    }
    frontier = following;
  }
  return { ids, relations: [...relations], distance, truncated };
}

/** Everything the arrows lead to from `id`, through any number of relations. */
export function downstreamOf(model: ArchModel, id: string, filter?: RelationFilter, limit = REACH_LIMIT): Reach {
  return walk(model, id, true, filter, limit);
}

/** Everything whose arrows lead to `id`, through any number of relations. */
export function upstreamOf(model: ArchModel, id: string, filter?: RelationFilter, limit = REACH_LIMIT): Reach {
  return walk(model, id, false, filter, limit);
}

/**
 * Loops among directed relations: each a set of parts that all reach one another, members sorted,
 * loops in the order their first member appears in the file. A line with no arrow never makes one.
 */
export function cyclesOf(model: ArchModel, filter?: RelationFilter): string[][] {
  const ids = [...model.entities.keys(), ...model.boundaries.keys()];
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const relation of model.relations) {
    if (!relation.directed || (filter && !filter(relation))) continue;
    const targets = adjacency.get(relation.from);
    if (targets && !targets.includes(relation.to)) targets.push(relation.to);
  }
  for (const targets of adjacency.values()) targets.sort(compareText);
  const order = new Map(ids.map((id, index) => [id, index]));
  return stronglyConnected(ids, adjacency)
    .components.filter((component) => component.loop)
    .map((component) => component.members)
    .sort((a, b) => Math.min(...a.map((id) => order.get(id)!)) - Math.min(...b.map((id) => order.get(id)!)));
}

/** The relations that cross `boundary`: one end inside it, the other not. */
export function crossingsOf(model: ArchModel, boundary: string): Relation[] {
  return model.relations.filter((relation) => relation.crosses.includes(boundary));
}

/** The parts inside `boundary`, however deeply nested in other boundaries within it. */
export function membersOf(model: ArchModel, boundary: string): string[] {
  const members: string[] = [];
  for (const entity of model.entities.values()) if (entity.boundaries.includes(boundary)) members.push(entity.id);
  return members;
}

export interface Shared {
  /** The part several others point at. */
  id: string;
  /** Who points at it, in file order. */
  by: string[];
}

/** Parts that two or more others have a relation to: what they have in common, for better or worse. */
export function sharedBy(model: ArchModel, filter?: RelationFilter): Shared[] {
  const users = new Map<string, string[]>();
  for (const relation of model.relations) {
    if (filter && !filter(relation)) continue;
    const list = users.get(relation.to);
    if (!list) users.set(relation.to, [relation.from]);
    else if (!list.includes(relation.from)) list.push(relation.from);
  }
  return [...users].filter(([, by]) => by.length > 1).map(([id, by]) => ({ id, by }));
}
