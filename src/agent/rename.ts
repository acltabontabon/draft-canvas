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
