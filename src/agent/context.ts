/**
 * `collectNotes`: notes relevant to a view or a scope, gathered from every place a note can live in
 * the document — shared by `read_selection` and `get_implementation_context` (below) so both give the
 * same honest answer instead of two slightly different guesses.
 *
 * A note is included only when its relevance is structural (a folded attachment on the id it's about,
 * or an action's own anchor) or, as an explicitly lower-confidence fallback, a freestanding note
 * positioned close enough to something to be reasonably read as being about it. Proximity is never
 * silently promoted to the same authority as an explicit attachment: every entry carries its
 * `provenance`, so a reader can weigh "attached decision" against "text that happens to be nearby".
 *
 * `buildImplementationContext`: `get_implementation_context`'s focused read for implementing an
 * agreed design — flow step order, notes, and boundaries. See its own doc comment below.
 */

import { viewOf, type DepthPath } from '../depth/tree';
import type { DraftDocument, DraftNode } from '../document/types';
import { nearestElement } from './read';
import { groupKindOf } from './vocabulary';

export const NOTES_LIMIT = 100;

export interface NoteRef {
  id: string;
  text: string;
  kind?: string;
  /** 'attached': a folded Attachment on the element/relationship it's about — unambiguous.
   *  'nearest': a freestanding note, positionally associated with something — proximity, not structure. */
  provenance: 'attached' | 'nearest';
  about?: string;
}

export interface CollectNotesOptions {
  /** Restrict to notes about one of these ids. Omit to read every note in the view. */
  aboutIds?: ReadonlySet<string>;
}

export function collectNotes(view: DraftDocument, options: CollectNotesOptions = {}): { notes: NoteRef[]; truncated: boolean } {
  const { aboutIds } = options;
  const notes: NoteRef[] = [];
  let truncated = false;
  const want = (id: string) => !aboutIds || aboutIds.has(id);
  const push = (ref: NoteRef) => {
    if (notes.length >= NOTES_LIMIT) {
      truncated = true;
      return;
    }
    notes.push(ref);
  };

  for (const node of view.nodes) {
    if (!want(node.id)) continue;
    for (const a of node.attachments ?? []) {
      if (a.type !== 'note') continue;
      push({ id: a.id, text: a.text ?? '', kind: a.noteKind, provenance: 'attached', about: node.id });
    }
  }
  for (const edge of view.edges) {
    if (!want(edge.id)) continue;
    for (const a of edge.attachments ?? []) {
      if (a.type !== 'note') continue;
      push({ id: a.id, text: a.text ?? '', kind: a.noteKind, provenance: 'attached', about: edge.id });
    }
  }

  const freestanding = view.nodes.filter((n): n is DraftNode => n.type === 'note');
  for (const note of freestanding) {
    const nearest = nearestElement(note, view.nodes);
    if (aboutIds && (!nearest || !aboutIds.has(nearest))) continue;
    push({ id: note.id, text: note.text ?? '', kind: note.noteKind, provenance: 'nearest', about: nearest });
  }

  return { notes, truncated };
}

/**
 * `get_implementation_context`: flow step order exactly as stored (never inferred from screen
 * position), the notes/decisions about what's in focus, and the boundaries around it — a focused
 * read for an agent implementing an agreed design in the real repository, not a claim that the code
 * conforms to it.
 */
export interface FlowStepContext {
  order: number;
  edgeId?: string;
  from?: string;
  to?: string;
  label?: string;
  caption?: string;
  frame?: true;
}

export interface BoundaryContext {
  id: string;
  label: string;
  kind: string;
  memberIds: string[];
}

const FLOWS_LIMIT = 20;
const BOUNDARIES_LIMIT = 50;

export function buildImplementationContext(
  file: DraftDocument,
  path: DepthPath,
  revision: string,
  diagramId: string,
  focus: { flow?: unknown; nodes?: unknown } = {},
): Record<string, unknown> {
  const view = viewOf(file, path);
  const base = { diagramId, revision, view: { path: [...path] } };
  if (!view) return { ...base, message: 'That view no longer exists.' };

  const byEdgeId = new Map(view.edges.map((e) => [e.id, e]));
  const focusFlowId = typeof focus.flow === 'string' ? focus.flow : undefined;
  const focusNodes = Array.isArray(focus.nodes) ? focus.nodes.filter((id): id is string => typeof id === 'string') : undefined;

  const flowsToShow = focusFlowId ? view.flows.filter((f) => f.id === focusFlowId) : view.flows;
  const flowsTruncated = !focusFlowId && flowsToShow.length > FLOWS_LIMIT;
  const flows = flowsToShow.slice(0, FLOWS_LIMIT).map((flow) => ({
    id: flow.id,
    title: flow.title,
    // Order is the array's own position — the one thing a flow's steps carry that nothing about
    // layout, geometry or graph traversal could recover if this were inferred instead of read.
    steps: flow.steps.map((step, i): FlowStepContext => {
      if (!step.edgeId) return { order: i, frame: true, ...(step.caption ? { caption: step.caption } : {}) };
      const edge = byEdgeId.get(step.edgeId);
      return {
        order: i,
        edgeId: step.edgeId,
        ...(edge ? { from: edge.source, to: edge.target, ...(edge.label ? { label: edge.label } : {}) } : {}),
        ...(step.caption ? { caption: step.caption } : {}),
      };
    }),
  }));

  // What "in focus" means for notes/boundaries: explicit ids, every id a focused flow's steps touch,
  // or (neither given) the whole view — bounded either way by collectNotes'/this function's own caps.
  let aboutIds: Set<string> | undefined;
  if (focusNodes) aboutIds = new Set(focusNodes);
  else if (focusFlowId) {
    const flow = view.flows.find((f) => f.id === focusFlowId);
    aboutIds = new Set<string>();
    for (const step of flow?.steps ?? []) {
      if (step.edgeId) {
        aboutIds.add(step.edgeId);
        const edge = byEdgeId.get(step.edgeId);
        if (edge) {
          aboutIds.add(edge.source);
          aboutIds.add(edge.target);
        }
      }
      for (const id of step.extraNodeIds ?? []) aboutIds.add(id);
      for (const id of step.extraEdgeIds ?? []) aboutIds.add(id);
    }
  }

  const { notes, truncated: notesTruncated } = collectNotes(view, { aboutIds });

  const inFocus = (id: string) => !aboutIds || aboutIds.has(id);
  const groups = view.nodes.filter((n) => n.type === 'group' && (inFocus(n.id) || view.nodes.some((m) => m.parentId === n.id && inFocus(m.id))));
  const boundariesTruncated = groups.length > BOUNDARIES_LIMIT;
  const boundaries: BoundaryContext[] = groups.slice(0, BOUNDARIES_LIMIT).map((g) => ({
    id: g.id,
    label: g.text ?? '',
    kind: groupKindOf(g.boundaryPreset),
    memberIds: view.nodes.filter((n) => n.parentId === g.id).map((n) => n.id),
  }));

  return {
    ...base,
    flows,
    ...(notes.length ? { notes } : {}),
    ...(boundaries.length ? { boundaries } : {}),
    ...(flowsTruncated || notesTruncated || boundariesTruncated
      ? { truncated: { ...(flowsTruncated ? { flows: true } : {}), ...(notesTruncated ? { notes: true } : {}), ...(boundariesTruncated ? { boundaries: true } : {}) } }
      : {}),
  };
}
