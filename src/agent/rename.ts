import { roomsOf } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { isArchitecture, isBoundary } from '../export/source/shared';
import { AgentError } from './errors';
import { viewPathOf } from './read';

/** Exact-label resolution is a precondition, not a fuzzy search or a last-writer-wins edit.
 * Return an ordinary patch so history, concurrency, layout validation and review stay shared. */
export function renamePatch(file: DraftDocument, rename: { from: string; to: string }, view?: unknown) {
  const path = view === undefined ? undefined : viewPathOf(file, view);
  const matches = roomsOf(file).filter((room) => !path || JSON.stringify(room.path) === JSON.stringify(path))
    .flatMap((room) => room.graph.nodes.filter((node) => (isArchitecture(node) || isBoundary(node)) && node.text === rename.from)
      .map((node) => ({ id: node.id, path: [...room.path] })));
  // No architecture shape has that label: a group of linked junctions may. Every junction carrying it
  // is then one point, renamed as one (`update` writes a junction's label on its whole group).
  if (matches.length === 0) {
    const junctions = roomsOf(file).filter((room) => !path || JSON.stringify(room.path) === JSON.stringify(path))
      .flatMap((room) => room.graph.nodes.filter((node) => node.type === 'ellipse' && node.text === rename.from).map((node) => ({ id: node.id, link: node.link, path: [...room.path] })));
    const links = new Set(junctions.map((junction) => junction.link));
    if (junctions.length > 0 && links.size === 1 && junctions[0]!.link) {
      return { view: { inside: junctions[0]!.path }, ops: [{ op: 'update', id: junctions[0]!.id, set: { label: rename.to } }] };
    }
    matches.push(...junctions.map(({ id, path: at }) => ({ id, path: at })));
  }
  if (matches.length !== 1) {
    throw new AgentError(matches.length ? 'INVALID_INPUT' : 'NOT_FOUND', matches.length
      ? 'More than one shape has that exact label. Nothing changed.'
      : 'No shape has that exact current label. Nothing changed.', {
      hint: 'Use read_diagram with query to locate the target, then update_diagram with its id and revision.',
      details: { matches: matches.slice(0, 20), total: matches.length },
    });
  }
  return { view: { inside: matches[0]!.path }, ops: [{ op: 'update', id: matches[0]!.id, set: { label: rename.to } }] };
}
