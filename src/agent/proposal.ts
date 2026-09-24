/**
 * `submit_proposal`'s dry-run half: validates a batch of ops against the *current* document exactly
 * as `update_diagram` would (so a bad proposal is refused at submit time, not discovered at review),
 * and captures a bounded "precondition" snapshot — the before-state of every id the ops touch — which
 * is the review UI's conflict-detection mechanism (Phase 4b), distinct from base-revision staleness.
 *
 * Never commits anything: `applyUpdate`'s resulting file is deliberately discarded here.
 */

import type { DepthPath } from '../depth/tree';
import { viewOf } from '../depth/tree';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { applyUpdate, type PatchResult } from './patch';

export interface PreconditionSnapshot {
  nodes: Record<string, { label: string; type: string; group?: string }>;
  edges: Record<string, { from: string; to: string; label?: string }>;
}

export interface PreparedProposal {
  counts: PatchResult['counts'];
  advisories: string[];
  preconditions: PreconditionSnapshot;
}

export function prepareProposal(file: DraftDocument, path: DepthPath, rawOps: unknown, rawLayout: unknown, rawScope: unknown): PreparedProposal {
  const result = applyUpdate(file, path, rawOps, rawLayout, rawScope);
  const before = viewOf(file, path);
  const preconditions: PreconditionSnapshot = { nodes: {}, edges: {} };
  if (before) {
    const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
    const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
    for (const id of result.touched) {
      const node = beforeNodes.get(id);
      if (node) {
        preconditions.nodes[id] = { label: node.text ?? '', type: node.type, ...(node.parentId ? { group: node.parentId } : {}) };
        continue;
      }
      const edge = beforeEdges.get(id);
      if (edge) preconditions.edges[id] = { from: edge.source, to: edge.target, ...(edge.label ? { label: edge.label } : {}) };
    }
  }
  return { counts: result.counts, advisories: result.advisories, preconditions };
}

/**
 * What changed between a proposal's captured preconditions and the document as it stands now — the
 * blocking conflict check. A successful re-run of the same ops is *not* treated as proof there's no
 * conflict; this comparison is the actual check (see `docs/reference/agent-integration.md`).
 */
export interface PreconditionConflict {
  id: string;
  kind: 'node' | 'edge';
  was: Record<string, unknown>;
  now: Record<string, unknown> | null;
}

export function preconditionConflicts(file: DraftDocument, path: DepthPath, preconditions: PreconditionSnapshot): PreconditionConflict[] {
  const view = viewOf(file, path);
  const conflicts: PreconditionConflict[] = [];
  const nodes = new Map((view?.nodes ?? []).map((n) => [n.id, n]));
  const edges = new Map((view?.edges ?? []).map((e) => [e.id, e]));
  for (const [id, was] of Object.entries(preconditions.nodes)) {
    const now = nodes.get(id);
    const nowValue = now ? { label: now.text ?? '', type: now.type, ...(now.parentId ? { group: now.parentId } : {}) } : null;
    if (!nowValue || nowValue.label !== was.label || nowValue.type !== was.type || nowValue.group !== was.group) {
      conflicts.push({ id, kind: 'node', was, now: nowValue });
    }
  }
  for (const [id, was] of Object.entries(preconditions.edges)) {
    const now = edges.get(id);
    const nowValue = now ? { from: now.source, to: now.target, ...(now.label ? { label: now.label } : {}) } : null;
    if (!nowValue || nowValue.from !== was.from || nowValue.to !== was.to || nowValue.label !== was.label) {
      conflicts.push({ id, kind: 'edge', was, now: nowValue });
    }
  }
  return conflicts;
}

/**
 * A real, field-level change list for the review panel — additions, modifications and removals
 * shown apart (never color alone), and for a modification, the actual before→after values rather
 * than a canvas ghost, since the spec explicitly requires reviewing non-geometric changes (a label,
 * a note's text, a relationship's semantic) that a colored outline can't show.
 */
export interface DiffField {
  field: string;
  before?: string;
  after?: string;
}

export interface ElementDiffRow {
  kind: 'element' | 'group' | 'relationship';
  id: string;
  change: 'added' | 'modified' | 'removed';
  label: string;
  fields?: DiffField[];
}

function nodeFields(n: DraftNode): Record<string, string | undefined> {
  return { label: n.text, type: n.type, description: n.description, technology: n.technology, group: n.parentId };
}

function edgeFields(e: DraftEdge): Record<string, string | undefined> {
  return { label: e.label, semantic: e.semantic, kind: e.kind, condition: e.condition };
}

function changedFields(before: Record<string, string | undefined>, after: Record<string, string | undefined>): DiffField[] {
  return Object.keys({ ...before, ...after })
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

export function diffForReview(before: DraftDocument, after: DraftDocument, path: DepthPath): ElementDiffRow[] {
  const beforeView = viewOf(before, path);
  const afterView = viewOf(after, path);
  const rows: ElementDiffRow[] = [];

  const beforeNodes = new Map((beforeView?.nodes ?? []).map((n) => [n.id, n]));
  const afterNodes = new Map((afterView?.nodes ?? []).map((n) => [n.id, n]));
  for (const [id, node] of afterNodes) {
    const kind = node.type === 'group' ? 'group' : 'element';
    const was = beforeNodes.get(id);
    if (!was) {
      rows.push({ kind, id, change: 'added', label: node.text ?? '' });
      continue;
    }
    const fields = changedFields(nodeFields(was), nodeFields(node));
    if (fields.length) rows.push({ kind, id, change: 'modified', label: node.text ?? was.text ?? '', fields });
  }
  for (const [id, was] of beforeNodes) {
    if (!afterNodes.has(id)) rows.push({ kind: was.type === 'group' ? 'group' : 'element', id, change: 'removed', label: was.text ?? '' });
  }

  const beforeEdges = new Map((beforeView?.edges ?? []).map((e) => [e.id, e]));
  const afterEdges = new Map((afterView?.edges ?? []).map((e) => [e.id, e]));
  for (const [id, edge] of afterEdges) {
    const was = beforeEdges.get(id);
    if (!was) {
      rows.push({ kind: 'relationship', id, change: 'added', label: edge.label ?? '' });
      continue;
    }
    const fields = changedFields(edgeFields(was), edgeFields(edge));
    if (fields.length) rows.push({ kind: 'relationship', id, change: 'modified', label: edge.label ?? was.label ?? '', fields });
  }
  for (const [id, was] of beforeEdges) {
    if (!afterEdges.has(id)) rows.push({ kind: 'relationship', id, change: 'removed', label: was.label ?? '' });
  }

  return rows;
}
