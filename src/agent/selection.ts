/**
 * `read_selection`: a read-only, bounded snapshot of what the person currently has selected —
 * stable ids, a bounded set of neighbors distinguished from the selection itself, and the notes
 * about it. An agent captures this once and passes the frozen ids back as `scope` on a later
 * `update_diagram`/`submit_proposal`, so a selection change on screen afterward can't silently
 * retarget an edit already in flight (see `patch.ts`'s scope enforcement).
 *
 * Never invents a scope: an empty selection is reported as such, not defaulted to "everywhere".
 */

import type { Selection } from '../history/HistoryStack';
import { classify } from '../depth/c4';
import { effectiveLevel } from '../depth/level';
import { ownerAt, viewOf, type DepthPath } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { collectNotes, collectSnippets } from './context';
import { c4Of, relationshipOf } from './read';
import { typeWordOf } from './vocabulary';

/** How many context (unselected) elements/relationships ride along, at most. */
export const NEIGHBOR_LIMIT = 50;

export function readSelectionContext(file: DraftDocument, path: DepthPath, selection: Selection, revision: string, diagramId: string): Record<string, unknown> {
  const view = viewOf(file, path);
  const base = { diagramId, revision, view: { path: [...path] } };
  if (!view) return { ...base, selection: null, message: 'That view no longer exists.' };

  const selectedNodes = new Set(selection.nodes);
  const selectedEdges = new Set(selection.edges);
  if (selectedNodes.size === 0 && selectedEdges.size === 0) {
    return { ...base, selection: null, message: 'Nothing is selected. Ask the person to select what to change, or read the whole view with read_diagram.' };
  }

  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const level = effectiveLevel(file, path);
  // Classified as read_diagram classifies it: inside its owner, within any system boundary.
  const owner = path.length ? ownerAt(file, path) : undefined;
  const systemBoundaryOf = (id: string) => {
    const seen = new Set<string>();
    for (let at = byId.get(id)?.parentId; at && !seen.has(at); at = byId.get(at)?.parentId) {
      seen.add(at);
      if (byId.get(at)?.boundaryPreset === 'system') return byId.get(at);
    }
    return undefined;
  };

  // Context: edges touching a selected node, and the node at their other end — bounded, and always
  // distinguishable from the selection itself.
  const contextEdges = new Set<string>();
  const contextNodes = new Set<string>();
  let neighborsTruncated = false;
  for (const edge of view.edges) {
    if (selectedEdges.has(edge.id)) continue;
    const touchesSelected = selectedNodes.has(edge.source) || selectedNodes.has(edge.target);
    if (!touchesSelected) continue;
    if (contextEdges.size >= NEIGHBOR_LIMIT) {
      neighborsTruncated = true;
      break;
    }
    contextEdges.add(edge.id);
    for (const end of [edge.source, edge.target]) {
      if (!selectedNodes.has(end) && byId.has(end) && contextNodes.size < NEIGHBOR_LIMIT) contextNodes.add(end);
    }
  }

  const elements: unknown[] = [];
  const groups: unknown[] = [];
  for (const id of [...selectedNodes, ...contextNodes]) {
    const node = byId.get(id);
    if (!node) continue;
    const role = selectedNodes.has(id) ? 'selected' : 'context';
    if (node.type === 'group') {
      groups.push({ id: node.id, label: node.text ?? '', role, ...(node.parentId ? { parent: node.parentId } : {}) });
      continue;
    }
    const systemBoundary = systemBoundaryOf(node.id);
    const c4 = c4Of(classify(node, { level, ...(owner ? { insideOwner: owner } : {}), ...(systemBoundary ? { systemBoundary } : {}) }));
    elements.push({
      id: node.id,
      type: typeWordOf(node),
      label: node.text ?? '',
      role,
      ...(node.description ? { description: node.description } : {}),
      ...(node.technology ? { technology: node.technology } : {}),
      ...(node.accent ? { color: node.accent } : {}),
      ...(node.parentId ? { group: node.parentId } : {}),
      ...(c4 ? { c4 } : {}),
    });
  }

  const relationships: unknown[] = [];
  for (const id of [...selectedEdges, ...contextEdges]) {
    const edge = view.edges.find((e) => e.id === id);
    if (!edge) continue;
    const selected = selectedEdges.has(id);
    // A selected relationship's notes and snippets come once, in notes/snippets (about its id); its
    // own entry counts them rather than carrying every body a second time.
    relationships.push({ ...relationshipOf(edge, byId, !selected), role: selected ? 'selected' : 'context' });
  }

  const { notes, truncated: notesTruncated } = collectNotes(view, { aboutIds: new Set([...selectedNodes, ...selectedEdges]) });
  const { snippets, truncated: snippetsTruncated } = collectSnippets(view, { aboutIds: new Set([...selectedNodes, ...selectedEdges]) });

  return {
    ...base,
    selection: { path: [...path], nodes: [...selectedNodes], edges: [...selectedEdges] },
    elements,
    relationships,
    ...(groups.length ? { groups } : {}),
    ...(notes.length ? { notes } : {}),
    ...(snippets.length ? { snippets } : {}),
    ...(notesTruncated || snippetsTruncated || neighborsTruncated ? { truncated: { ...(notesTruncated ? { notes: true } : {}), ...(snippetsTruncated ? { snippets: true } : {}), ...(neighborsTruncated ? { neighbors: true } : {}) } } : {}),
  };
}
