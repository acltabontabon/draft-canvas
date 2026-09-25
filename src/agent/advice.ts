/**
 * What an agent could change in its *request* to get a clearer diagram — the part of legibility the
 * layout can't fix on its own, because it is in what was asked for. Each piece of advice names the
 * ids involved and, where there is one, the `update_diagram` op that would act on it, so the agent can
 * apply it in the same turn instead of guessing.
 *
 * Pure: it reads the checked request and the arrangement's legibility, and imports nothing that
 * touches the page, so it runs on the agent worker with the rest of `compose`.
 */

import type { Legibility } from './legibility';
import type { RoomSpec } from './input';

/** More elements than this in one view read as a wall; the next C4 level is where the rest go. */
export const CROWDED_VIEW = 15;
/** A boundary holding more than this is a view of its own waiting to happen. */
export const CROWDED_BOUNDARY = 8;
/** Past this many crossings, the request's reading order is worth a second look. */
const MANY_CROSSINGS = 6;

const quote = (ids: readonly string[], max = 4) => ids.slice(0, max).map((id) => `"${id}"`).join(', ') + (ids.length > max ? `, …` : '');

export function adviceFor(room: RoomSpec, legibility: Legibility, primaryFlow?: string): string[] {
  const out: string[] = [];
  const byId = new Map(room.nodes.map((n) => [n.id, n]));

  // A boundary of external systems (or people) each called from a different shape: laid out as one
  // block, its members can only line up with one caller between them — the rest reach round.
  for (const group of room.groups) {
    const members = room.nodes.filter((n) => n.group === group.id);
    if (members.length < 2 || room.groups.some((g) => g.parent === group.id)) continue;
    const outside = members.every((n) => n.shape.serviceKind === 'external' || n.shape.type === 'actor');
    if (!outside) continue;
    const inside = (id: string) => byId.get(id)?.group === group.id;
    const crossing = room.relationships.filter((r) => inside(r.from) !== inside(r.to));
    const callers = new Set(crossing.map((r) => (inside(r.from) ? r.to : r.from)));
    // Only when it shows: the layout lines such a column up with its callers where it can.
    const troubled = new Set([...legibility.detours, ...legibility.throughBoundaries]);
    if (callers.size < 2 || !crossing.some((r) => troubled.has(r.id))) continue;
    const ops = members.map((m) => ({ op: 'update', id: m.id, set: { group: null } }));
    out.push(
      `Boundary "${group.id}" only gathers external systems that ${callers.size} different elements call, so it is placed as one block and most of its connectors reach around it. Unless it is a real boundary, ungroup its members so each sits beside its caller: ${JSON.stringify([...ops, { op: 'remove', ids: [group.id] }, { op: 'arrange' }])}.`,
    );
  }

  // Too much in one view: the next C4 level down is where detail goes, inside the element it details.
  const elements = room.nodes.length;
  const boundaries = room.groups
    .map((g) => ({ id: g.id, count: room.nodes.filter((n) => n.group === g.id).length }))
    .filter((g) => g.count > CROWDED_BOUNDARY)
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  if (boundaries.length) {
    const [biggest] = boundaries;
    out.push(
      `Boundary "${biggest!.id}" holds ${biggest!.count} elements. Consider drawing its detail one C4 level down instead: keep one element for it here and move the rest into that element's "inside" view.`,
    );
  } else if (elements > CROWDED_VIEW) {
    // A nested boundary (a domain inside the system) is the natural thing to move down a level.
    const nested = room.groups
      .filter((g) => g.parent)
      .map((g) => ({ id: g.id, count: room.nodes.filter((n) => n.group === g.id).length }))
      .filter((g) => g.count >= 3)
      .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1))[0];
    out.push(
      nested
        ? `${elements} elements in one view is a lot to read. Consider drawing boundary "${nested.id}" (${nested.count} elements) one C4 level down: keep its main element here and move the rest into that element's "inside" view.`
        : `${elements} elements in one view is a lot to read. Consider moving an element's internals into its "inside" view (the next C4 level) and keeping only that element here.`,
    );
  }

  // A note that says nothing about where it belongs lands after the diagram, far from what it means.
  const loose = room.notes.filter((n) => !n.near && !n.group && !n.attachTo).map((n) => n.id);
  if (loose.length) {
    out.push(`Note(s) ${quote(loose)} have no "about", so they were placed after the diagram. Give each the element, boundary or relationship it describes, e.g. {op:"update", id:"${loose[0]}", set:{about:"<element id>"}}.`);
  }

  // Lines everywhere: the request's order and main path are what the layout reads first.
  if (legibility.crossings >= MANY_CROSSINGS || legibility.detours.length >= 2 || legibility.throughBoundaries.length >= 3) {
    const hint = primaryFlow
      ? 'try {op:"arrange", direction:"down"}'
      : 'name the main path as a flow and pass it as layout.primaryFlow (or {op:"arrange", primaryFlow:"<flow id>"}) so it is drawn straight, and list elements in reading order, entry point first';
    const where = [...legibility.detours, ...legibility.throughBoundaries];
    out.push(`The arrangement has ${legibility.crossings} crossing(s)${where.length ? `, and connector(s) ${quote([...new Set(where)])} run around or through other parts` : ''}. To help: ${hint}.`);
  }
  return out;
}
